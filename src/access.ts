// /listings*・/api/listings* の Cloudflare Access を Worker 側でも確かめる（多層防御・fail-closed）。
//
// Access アプリが /listings* と /api/listings* の前に立つ前提だが、workers.dev 側の URL や設定漏れで
// Access を素通りしたリクエストもここで止める。JWT の検証そのものは関所（sekisho・Cloudflare Access の JWT を
// 検証する認証 Worker）に Service Binding の RPC で聞く（RS256・JWKS・iss/aud/exp/nbf・許可メールは関所が見る）。
//   - トークン: Cf-Access-Jwt-Assertion ヘッダ
//   - 通すのは関所が { kind: 'user' } を返したときだけ（サービストークンは受けない）
//   - binding（SEKISHO）未設定・CF_ACCESS_AUD 空・トークン無し・関所の例外・3 秒の打ち切り・想定外の戻り値は全部拒否
// ローカルだけの迂回: DEV_BYPASS_ACCESS=1 かつホスト名が localhost / 127.0.0.1（.dev.vars に書く）。

/** 関所の名乗り（sekisho の README「RPC」） */
export type SekishoPrincipal = { kind: "user"; email: string } | { kind: "service"; clientId: string };

/** 関所の RPC（sekisho の default export の WorkerEntrypoint） */
export interface Sekisho {
  verify(token: string | null | undefined, aud: string, opts?: { allowServiceTokens?: boolean }): Promise<SekishoPrincipal | null>;
}

export interface AccessEnv {
  /** 関所への Service Binding（wrangler.toml の [[services]]） */
  SEKISHO?: Sekisho;
  /** Access アプリの Application Audience (AUD) Tag */
  CF_ACCESS_AUD?: string;
  DEV_BYPASS_ACCESS?: string;
}

/** 関所の RPC を待つ上限。過ぎたら認証なし扱い */
export const SEKISHO_TIMEOUT_MS = 3000;

export type AccessResult = { ok: true; email: string } | { ok: false; response: Response };

const deny = (status: 401 | 403, msg: string): AccessResult => ({
  ok: false,
  response: new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  }),
});

const TIMEOUT = Symbol("timeout");

/** 関所に聞く。例外・打ち切り・想定外の戻り値は null（fail-closed） */
async function askSekisho(sekisho: Sekisho, token: string, aud: string, timeoutMs: number): Promise<SekishoPrincipal | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const p: unknown = await Promise.race([sekisho.verify(token, aud), timeout]);
    if (p === TIMEOUT) {
      console.warn("Access: 関所が時間内に答えない");
      return null;
    }
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    if (r.kind === "user" && typeof r.email === "string" && r.email) return { kind: "user", email: r.email };
    if (r.kind === "service" && typeof r.clientId === "string") return { kind: "service", clientId: r.clientId };
    return null;
  } catch (e) {
    console.warn(`Access: 関所の呼び出しに失敗 ${e instanceof Error ? e.name : "error"}`);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function requireAccess(req: Request, env: AccessEnv, opts?: { timeoutMs?: number }): Promise<AccessResult> {
  const host = new URL(req.url).hostname;
  if (env.DEV_BYPASS_ACCESS === "1" && (host === "localhost" || host === "127.0.0.1")) {
    return { ok: true, email: "dev@localhost" };
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  const aud = typeof env.CF_ACCESS_AUD === "string" ? env.CF_ACCESS_AUD.trim() : "";
  const sekisho = env.SEKISHO;
  if (!token || !aud || !sekisho || typeof sekisho.verify !== "function") return deny(401, "Unauthorized");
  const p = await askSekisho(sekisho, token, aud, opts?.timeoutMs ?? SEKISHO_TIMEOUT_MS);
  // 不正・期限切れ・許可メール外は関所がどれも null を返す（区別できない）ので 401。サービストークンは 403
  if (!p) return deny(401, "Unauthorized");
  if (p.kind !== "user") return deny(403, "Forbidden");
  return { ok: true, email: p.email.toLowerCase() };
}

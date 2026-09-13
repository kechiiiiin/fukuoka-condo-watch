// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を Worker 側でも検証する（多層防御・fail-closed）。
//
// Access アプリが /listings* と /api/listings* の前に立つ前提だが、workers.dev 側の URL や設定漏れで
// Access を素通りしたリクエストもここで止める。依存を増やさないよう WebCrypto（RS256）で検証する。
//   - 鍵: <CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs の JWKS（1 時間キャッシュ・未知の kid なら 1 回だけ取り直す）
//   - 検証: alg=RS256・署名・iss=チームドメイン・aud に CF_ACCESS_AUD を含む・exp/nbf（60 秒の揺らぎ）
//   - さらに email が ALLOWED_EMAILS（カンマ区切り・secret）に含まれること。**未設定なら全員拒否**
//   - CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD が未設定なら全員拒否（Access を作る前にマージしても開かない）
// ローカルだけの迂回: DEV_BYPASS_ACCESS=1 かつホスト名が localhost / 127.0.0.1（.dev.vars に書く）。

export interface AccessEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  DEV_BYPASS_ACCESS?: string;
}

export class AccessError extends Error {}

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; alg?: string };
type FetchLike = (url: string) => Promise<Response>;

const JWKS_TTL_MS = 3600_000;
const REFETCH_MIN_MS = 60_000;
const SKEW_S = 60;
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

/** "myteam" / "myteam.cloudflareaccess.com" / "https://myteam.cloudflareaccess.com/" → "https://myteam.cloudflareaccess.com" */
export function normalizeTeamDomain(v: string | undefined): string | null {
  let s = (v ?? "").trim();
  if (!s) return null;
  if (!s.includes(".")) s = `${s}.cloudflareaccess.com`;
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname.endsWith(".cloudflareaccess.com")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  const v: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AccessError("JWT の形式が不正");
  return v as Record<string, unknown>;
}

async function getKeys(team: string, fetchImpl: FetchLike, now: number, force: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(team);
  if (hit && (now - hit.fetchedAt < (force ? REFETCH_MIN_MS : JWKS_TTL_MS))) return hit.keys;
  const res = await fetchImpl(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError(`certs 取得失敗 HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(team, { keys, fetchedAt: now });
  return keys;
}

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  /** ミリ秒 */
  now?: number;
  fetchImpl?: FetchLike;
}

export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<Record<string, unknown>> {
  const team = normalizeTeamDomain(opts.teamDomain);
  if (!team) throw new AccessError("CF_ACCESS_TEAM_DOMAIN が不正");
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? ((u: string) => fetch(u));
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("JWT の形式が不正");
  const [h, p, sig] = parts as [string, string, string];
  const header = b64urlJson(h);
  if (header.alg !== "RS256") throw new AccessError("alg が RS256 ではない");
  const kid = typeof header.kid === "string" ? header.kid : null;

  let keys = await getKeys(team, fetchImpl, now, false);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await getKeys(team, fetchImpl, now, true);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new AccessError("対応する鍵が無い");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError("署名が不正");

  const payload = b64urlJson(p);
  if (payload.iss !== team) throw new AccessError("iss が一致しない");
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!opts.aud || !auds.includes(opts.aud)) throw new AccessError("aud が一致しない");
  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp + SKEW_S < nowS) throw new AccessError("期限切れ");
  if (typeof payload.nbf === "number" && payload.nbf - SKEW_S > nowS) throw new AccessError("まだ有効でない");
  return payload;
}

export type AccessResult = { ok: true; email: string } | { ok: false; response: Response };

const deny = (status: 401 | 403, msg: string): AccessResult => ({
  ok: false,
  response: new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  }),
});

export async function requireAccess(req: Request, env: AccessEnv, fetchImpl?: FetchLike, now?: number): Promise<AccessResult> {
  const host = new URL(req.url).hostname;
  if (env.DEV_BYPASS_ACCESS === "1" && (host === "localhost" || host === "127.0.0.1")) {
    return { ok: true, email: "dev@localhost" };
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  const team = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!token || !team || !aud) return deny(401, "Unauthorized");
  let payload: Record<string, unknown>;
  try {
    payload = await verifyAccessJwt(token, { teamDomain: team, aud, fetchImpl, now });
  } catch (e) {
    console.warn(`Access JWT 拒否: ${e instanceof Error ? e.message : String(e)}`);
    return deny(401, "Unauthorized");
  }
  const email = String(payload.email ?? "").toLowerCase();
  const allowed = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!email || allowed.length === 0 || !allowed.includes(email)) return deny(403, "Forbidden");
  return { ok: true, email };
}

/** テスト用 */
export function clearJwksCache(): void {
  jwksCache.clear();
}

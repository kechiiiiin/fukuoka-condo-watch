// /listings・/api/listings を守る Cloudflare Access アプリを API で作る。**既定は dry-run（何も作らない）**。
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   ACCESS_HOSTNAME=condo.kechiiiiin.com ACCESS_EMAILS=you@example.com \
//   npm run access-app                 # 送る JSON を表示するだけ
//   npm run access-app -- --apply      # 作る（同名のアプリ・ポリシーがあれば作らずに再利用）
//
// 必要な API トークン権限（アカウント単位）:
//   - Access: Apps and Policies — Edit（API 上の scope 名 com.cloudflare.api.account.access:edit）
//   - Access: Organizations, Identity Providers, and Groups — Read（チームドメインの取得。無ければ ACCESS_TEAM_DOMAIN を渡す）
// トークンは環境変数でだけ渡す。ファイル・リポジトリに書かない。
//
// 使う API（https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/ ）:
//   GET  /accounts/{account_id}/access/organizations        → auth_domain（<team>.cloudflareaccess.com）
//   GET  /accounts/{account_id}/access/policies             → 同名の再利用可能ポリシーを探す
//   POST /accounts/{account_id}/access/policies             → { name, decision: "allow", include: [{ email: { email } }] }
//   GET  /accounts/{account_id}/access/apps                 → 同名のアプリを探す
//   POST /accounts/{account_id}/access/apps                 → { type: "self_hosted", destinations: [...], policies: [{ id, precedence }] }
// 作ったあとの aud を CF_ACCESS_AUD、auth_domain を CF_ACCESS_TEAM_DOMAIN として wrangler.toml の [vars] に書く。

const API = "https://api.cloudflare.com/client/v4";
const APP_NAME = "fukuoka-condo-watch listings";
const POLICY_NAME = "fukuoka-condo-watch listings: owner";

interface CfResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`環境変数 ${name} が必要です`);
    process.exit(2);
  }
  return v;
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as CfResponse<T>;
  if (!res.ok || !json.success) {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

export function buildBodies(hostname: string, emails: string[]) {
  const policy = {
    name: POLICY_NAME,
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
    session_duration: "24h",
  };
  // パスはそのパス以下にも効くが、念のため /* も並べる（重複しても挙動は同じ）
  const paths = ["/listings", "/listings/*", "/api/listings", "/api/listings/*"];
  const app = {
    name: APP_NAME,
    type: "self_hosted",
    domain: `${hostname}/listings`,
    destinations: paths.map((p) => ({ type: "public", uri: `${hostname}${p}` })),
    session_duration: "24h",
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    // policies は作成時に { id, precedence } で差し込む
  };
  return { policy, app };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const hostname = need("ACCESS_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const emails = need("ACCESS_EMAILS")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const { policy, app } = buildBodies(hostname, emails);

  if (!apply) {
    console.log("dry-run（--apply で作成）。送る内容:");
    console.log(JSON.stringify({ policy: { ...policy, include: `${emails.length} 件のメール` }, app }, null, 2));
    return;
  }

  const token = need("CLOUDFLARE_API_TOKEN");
  const account = need("CLOUDFLARE_ACCOUNT_ID");

  let teamDomain = process.env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) {
    const org = await cf<{ auth_domain: string }>(token, "GET", `/accounts/${account}/access/organizations`);
    teamDomain = org.auth_domain;
  }

  const policies = await cf<{ id: string; name: string }[]>(token, "GET", `/accounts/${account}/access/policies`);
  let policyId = policies.find((p) => p.name === POLICY_NAME)?.id;
  if (policyId) console.log(`既存のポリシーを使う: ${policyId}`);
  else {
    policyId = (await cf<{ id: string }>(token, "POST", `/accounts/${account}/access/policies`, policy)).id;
    console.log(`ポリシーを作成: ${policyId}`);
  }

  const apps = await cf<{ id: string; name: string; aud: string }[]>(token, "GET", `/accounts/${account}/access/apps`);
  let created = apps.find((a) => a.name === APP_NAME);
  if (created) console.log(`既存のアプリを使う: ${created.id}（destinations・policies は変更しない）`);
  else {
    created = await cf<{ id: string; name: string; aud: string }>(token, "POST", `/accounts/${account}/access/apps`, {
      ...app,
      policies: [{ id: policyId, precedence: 1 }],
    });
    console.log(`アプリを作成: ${created.id}`);
  }

  console.log("\nwrangler.toml の [vars] に書く値:");
  console.log(`CF_ACCESS_TEAM_DOMAIN = "https://${teamDomain.replace(/^https?:\/\//, "")}"`);
  console.log(`CF_ACCESS_AUD = "${created.aud}"`);
  console.log("\n確認（未ログインなら 302 で cloudflareaccess.com へ飛ぶこと）:");
  console.log(`curl -sI https://${hostname}/listings | head -5`);
  console.log(`curl -sI https://${hostname}/api/listings/status | head -5`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

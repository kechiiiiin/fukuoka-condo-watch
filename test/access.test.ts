// Access JWT 検証（src/access.ts）のテスト。鍵はその場で作り、certs は偽の fetch で返す。
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearJwksCache, normalizeTeamDomain, requireAccess, verifyAccessJwt } from "../src/access.ts";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function setup() {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  let certFetches = 0;
  const fetchImpl = async (url: string) => {
    certFetches++;
    assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...pub, kid: "k1", alg: "RS256", use: "sig" }] }));
  };
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }) => {
    const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  const good = { iss: TEAM, aud: [AUD], email: "Owner@Example.com", exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10 };
  return { sign, fetchImpl, good, certFetches: () => certFetches };
}

test("チームドメインの正規化", () => {
  assert.equal(normalizeTeamDomain("example-team"), TEAM);
  assert.equal(normalizeTeamDomain("example-team.cloudflareaccess.com/"), TEAM);
  assert.equal(normalizeTeamDomain("https://evil.example.com"), null);
  assert.equal(normalizeTeamDomain(""), null);
});

test("正しい JWT は通り、改ざん・aud/iss 違い・期限切れ・alg 違いは落ちる", async () => {
  clearJwksCache();
  const { sign, fetchImpl, good, certFetches } = await setup();
  const opts = { teamDomain: TEAM, aud: AUD, now: NOW, fetchImpl };
  const payload = await verifyAccessJwt(await sign(good), opts);
  assert.equal(payload.email, "Owner@Example.com");
  await verifyAccessJwt(await sign(good), opts);
  assert.equal(certFetches(), 1, "certs はキャッシュされる");

  const tok = await sign(good);
  const [h, , s] = tok.split(".");
  const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify({ ...good, email: "attacker@example.com" })))}.${s}`;
  await assert.rejects(verifyAccessJwt(forged, opts), /署名/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, aud: ["other"] }), opts), /aud/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, iss: "https://x.cloudflareaccess.com" }), opts), /iss/);
  await assert.rejects(verifyAccessJwt(await sign({ ...good, exp: NOW / 1000 - 3600 }), opts), /期限/);
  await assert.rejects(verifyAccessJwt(await sign(good, { alg: "HS256", kid: "k1" }), opts), /RS256/);
  await assert.rejects(verifyAccessJwt(await sign(good, { alg: "RS256", kid: "nope" }), opts), /鍵/);
  await assert.rejects(verifyAccessJwt("a.b", opts), /形式/);
});

test("requireAccess: 未設定・トークン無し・allowlist 外は拒否、localhost の迂回は localhost だけ", async () => {
  clearJwksCache();
  const { sign, fetchImpl, good } = await setup();
  const token = await sign(good);
  const req = (host: string, withToken = true) =>
    new Request(`https://${host}/listings`, { headers: withToken ? { "Cf-Access-Jwt-Assertion": token } : {} });
  const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: "owner@example.com" };

  const ok = await requireAccess(req("condo.example.com"), env, fetchImpl, NOW);
  assert.equal(ok.ok, true);

  const noTok = await requireAccess(req("condo.example.com", false), env, fetchImpl, NOW);
  assert.equal(noTok.ok ? 0 : noTok.response.status, 401);
  const noAud = await requireAccess(req("condo.example.com"), { ...env, CF_ACCESS_AUD: "" }, fetchImpl, NOW);
  assert.equal(noAud.ok ? 0 : noAud.response.status, 401);
  const noList = await requireAccess(req("condo.example.com"), { ...env, ALLOWED_EMAILS: "" }, fetchImpl, NOW);
  assert.equal(noList.ok ? 0 : noList.response.status, 403);
  const other = await requireAccess(req("condo.example.com"), { ...env, ALLOWED_EMAILS: "someone@example.com" }, fetchImpl, NOW);
  assert.equal(other.ok ? 0 : other.response.status, 403);

  const bypassProd = await requireAccess(req("fukuoka-condo-watch.example.workers.dev", false), { DEV_BYPASS_ACCESS: "1" }, fetchImpl, NOW);
  assert.equal(bypassProd.ok, false);
  const bypassLocal = await requireAccess(new Request("http://127.0.0.1:8787/listings"), { DEV_BYPASS_ACCESS: "1" }, fetchImpl, NOW);
  assert.equal(bypassLocal.ok, true);
});

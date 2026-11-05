// /listings の Access 確認（src/access.ts）のテスト。関所（SEKISHO の Service Binding）はモックする。
import assert from "node:assert/strict";
import { test } from "node:test";
import { requireAccess, type AccessEnv, type Sekisho, type SekishoPrincipal } from "../src/access.ts";

const AUD = "aud-tag-123";
const EMAIL = "owner@example.com";
const GOOD = "good.jwt.token";
const SERVICE = "service.jwt.token";

/** GOOD はユーザー、SERVICE はサービストークン、それ以外・aud 違いは null。呼ばれた引数を残す */
function mockSekisho(impl?: Sekisho["verify"]) {
  const calls: unknown[][] = [];
  const verify: Sekisho["verify"] = async (...args) => {
    calls.push(args);
    if (impl) return impl(...args);
    const [token, aud] = args;
    if (aud !== AUD) return null;
    if (token === GOOD) return { kind: "user", email: EMAIL };
    if (token === SERVICE) return { kind: "service", clientId: "cid.access" };
    return null;
  };
  return { SEKISHO: { verify } satisfies Sekisho, calls };
}

const req = (token?: string, host = "condo.example.com") =>
  new Request(`https://${host}/listings`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
const status = (r: Awaited<ReturnType<typeof requireAccess>>) => (r.ok ? 200 : r.response.status);

test("認証済み（関所が user を返す）は通り、AUD とトークンをそのまま渡す（allowServiceTokens は渡さない）", async () => {
  const { SEKISHO, calls } = mockSekisho();
  const r = await requireAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: ` ${AUD} ` });
  assert.deepEqual(r.ok && r.email, EMAIL);
  assert.deepEqual(calls, [[GOOD, AUD]]);
});

test("未認証: トークン無し・不正トークン・aud 違いは 401。トークン無しは関所に聞かない", async () => {
  const { SEKISHO, calls } = mockSekisho();
  const env: AccessEnv = { SEKISHO, CF_ACCESS_AUD: AUD };
  assert.equal(status(await requireAccess(req(), env)), 401);
  assert.equal(calls.length, 0);
  assert.equal(status(await requireAccess(req("bad.jwt.token"), env)), 401);
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: "other-aud" })), 401);
});

test("関所が service を返したら拒否（403）", async () => {
  const { SEKISHO } = mockSekisho();
  assert.equal(status(await requireAccess(req(SERVICE), { SEKISHO, CF_ACCESS_AUD: AUD })), 403);
});

test("関所が throw・時間切れ・想定外の戻り値なら拒否（401）", async () => {
  const broken = mockSekisho(async () => {
    throw new Error("Service binding unavailable");
  });
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO: broken.SEKISHO, CF_ACCESS_AUD: AUD })), 401);

  const hang = mockSekisho(() => new Promise<SekishoPrincipal | null>(() => {}));
  const t0 = Date.now();
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO: hang.SEKISHO, CF_ACCESS_AUD: AUD }, { timeoutMs: 30 })), 401);
  assert.ok(Date.now() - t0 < 1000, "打ち切りで返る");

  for (const odd of [{ kind: "user" }, { kind: "user", email: 1 }, { kind: "admin", email: EMAIL }, "user", true]) {
    const m = mockSekisho(async () => odd as unknown as SekishoPrincipal);
    assert.equal(status(await requireAccess(req(GOOD), { SEKISHO: m.SEKISHO, CF_ACCESS_AUD: AUD })), 401, JSON.stringify(odd));
  }
});

test("binding 無し・verify が関数でない・AUD 空は拒否（401）", async () => {
  const { SEKISHO, calls } = mockSekisho();
  assert.equal(status(await requireAccess(req(GOOD), { CF_ACCESS_AUD: AUD })), 401);
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO: {} as unknown as Sekisho, CF_ACCESS_AUD: AUD })), 401);
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO, CF_ACCESS_AUD: "" })), 401);
  assert.equal(status(await requireAccess(req(GOOD), { SEKISHO })), 401);
  assert.equal(calls.length, 0);
});

test("localhost の迂回は DEV_BYPASS_ACCESS=1 かつ localhost / 127.0.0.1 だけ", async () => {
  const bypassProd = await requireAccess(req(undefined, "fukuoka-condo-watch.example.workers.dev"), { DEV_BYPASS_ACCESS: "1" });
  assert.equal(bypassProd.ok, false);
  const bypassLocal = await requireAccess(new Request("http://127.0.0.1:8787/listings"), { DEV_BYPASS_ACCESS: "1" });
  assert.equal(bypassLocal.ok, true);
  const noFlag = await requireAccess(new Request("http://localhost:8787/listings"), {});
  assert.equal(noFlag.ok, false);
});

// 取り込み口の Bearer 認証（src/ingest-auth.ts）。未設定なら fail-closed
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIngestToken, MIN_INGEST_TOKEN_LENGTH, timingSafeEqualStr } from "../src/ingest-auth.ts";

const TOKEN = "a".repeat(32) + "0123456789abcdef";

test("一致するトークンだけ通す", async () => {
  assert.equal(await checkIngestToken(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(await checkIngestToken(`bearer ${TOKEN}`, ` ${TOKEN}\n`), true);
  assert.equal(await checkIngestToken(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(await checkIngestToken(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  assert.equal(await checkIngestToken(TOKEN, TOKEN), false); // Bearer なし
  assert.equal(await checkIngestToken(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(await checkIngestToken(null, TOKEN), false);
  assert.equal(await checkIngestToken("Bearer ", TOKEN), false);
});

test("Worker 側のトークンが未設定・短すぎるなら全員拒否", async () => {
  assert.equal(await checkIngestToken("Bearer ", undefined), false);
  assert.equal(await checkIngestToken("Bearer ", ""), false);
  assert.equal(await checkIngestToken("Bearer   ", "   "), false);
  const short = "x".repeat(MIN_INGEST_TOKEN_LENGTH - 1);
  assert.equal(await checkIngestToken(`Bearer ${short}`, short), false);
});

test("定数時間比較", async () => {
  assert.equal(await timingSafeEqualStr("abc", "abc"), true);
  assert.equal(await timingSafeEqualStr("abc", "abd"), false);
  assert.equal(await timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(await timingSafeEqualStr("", ""), true);
});

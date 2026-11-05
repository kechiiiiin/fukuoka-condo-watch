// Mac 側クローラの共通部品（scripts/crawl-local-lib.ts）: 座標の周回の「今日は止められた」印
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blockedToday, jstDate, markBlocked } from "../scripts/crawl-local-lib.ts";

test("jstDate は Asia/Tokyo の暦日（UTC 15:00 で日が変わる）", () => {
  assert.equal(jstDate(new Date("2026-11-05T14:59:59Z")), "2026-11-05");
  assert.equal(jstDate(new Date("2026-11-05T15:00:00Z")), "2026-11-06");
});

test("止められた印: 同じ JST の日は有効・翌日は自動で無効・印が無い／壊れていれば止めない", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcw-block-"));
  const file = join(dir, "sub", "blocked.txt");
  const t = new Date("2026-11-05T01:00:00Z"); // JST 10:00
  assert.equal(blockedToday(t, file), null);
  markBlocked("redirect_challenge", t, file);
  assert.equal(blockedToday(new Date("2026-11-05T14:00:00Z"), file), "redirect_challenge"); // JST 23:00
  assert.equal(blockedToday(new Date("2026-11-05T15:00:00Z"), file), null); // JST 翌 00:00
  const bad = join(dir, "bad.txt");
  writeFileSync(bad, "");
  assert.equal(blockedToday(t, bad), null);
});

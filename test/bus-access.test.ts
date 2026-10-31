// /listings/bus（src/bus-access-dashboard.ts）と系統名の正規化（scripts/bus-access-lib.ts）のテスト。
// 画面は地図（Leaflet）を描くので DOM は立てず、HTML の部品と、埋め込みデータ・埋め込みスクリプトの形を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRouteKeys, splitRouteField } from "../scripts/bus-access-lib.ts";
import { LEAFLET_VERSION, renderBusAccessDashboard } from "../src/bus-access-dashboard.ts";

test("系統名の正規化: 種別・区間を除き「・」で分ける", () => {
  assert.deepEqual(normalizeRouteKeys("41"), ["41"]);
  assert.deepEqual(normalizeRouteKeys("38系統"), ["38"]);
  assert.deepEqual(normalizeRouteKeys("快速113・8"), ["113", "8"]);
  assert.deepEqual(normalizeRouteKeys("4［千早駅〜天神］"), ["4"]);
  assert.deepEqual(normalizeRouteKeys("30・32［イオン→大濠公園］"), ["30", "32"]);
  assert.deepEqual(normalizeRouteKeys("21系統-1"), ["21-1"]);
  assert.deepEqual(normalizeRouteKeys("急行26A循環"), ["26A"]);
  assert.deepEqual(normalizeRouteKeys("都高312［博多→藤崎］"), ["312"]);
  assert.deepEqual(normalizeRouteKeys("直方線　本線"), ["直方線 本線"]);
  assert.deepEqual(splitRouteField(["10系統,11・88系統,113", "13,15", null]), ["10系統", "11・88系統", "113", "13", "15"]);
});

test("/listings/bus の HTML: 地図・凡例・チェックボックス・出典・注意書き", () => {
  const html = renderBusAccessDashboard();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /noindex/);
  assert.ok(html.includes(`cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.js`));
  assert.ok(html.includes('<div id="map">'));
  for (const id of ["cb-0", "cb-1", "cb-2"]) assert.ok(html.includes(`id="${id}" checked`), id);
  assert.ok(html.includes('id="legend"'));
  assert.ok(html.includes("国土数値情報（バス停留所データ）国土交通省 2022年度 を加工して作成"));
  assert.ok(html.includes("OpenStreetMap"));
  assert.ok(html.includes("方向・経由の違いは区別していない"));

  // 埋め込みデータが JSON として読め、3 目的地とバス停が入っている
  const m = html.match(/var DATA = (\{.*?\});\n/s);
  assert.ok(m, "DATA が埋め込まれている");
  const data = JSON.parse(m[1]!) as { destinations: { label: string }[]; stops: { n: string; f: number }[] };
  assert.deepEqual(data.destinations.map((d) => d.label), ["天神", "祇園", "東福岡"]);
  assert.ok(data.stops.length > 500);
  assert.equal(data.stops.find((s) => s.n === "祇園町")?.f, 7);

  // 埋め込みスクリプトは構文として正しい（テンプレートへの展開漏れが無い）
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.ok(!script.includes("`"), "バッククォートを含まない");
  assert.doesNotThrow(() => new Function(script));
});

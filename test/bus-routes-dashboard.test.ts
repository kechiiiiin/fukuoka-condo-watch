// /listings/bus（src/bus-routes-dashboard.ts）のテスト。
// 画面は地図（Leaflet）を描くので DOM は立てず、HTML の部品と、埋め込みデータ・埋め込みスクリプトの形を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BusMapData,
  type BusRoutesData,
  jstDate,
  LEAFLET_VERSION,
  renderBusRoutesDashboard,
  toBusMapData,
} from "../src/bus-routes-dashboard.ts";

const embedded = (html: string): BusMapData => {
  const m = html.match(/var DATA = (\{.*?\});\n/s);
  assert.ok(m, "DATA が埋め込まれている");
  return JSON.parse(m[1]!) as BusMapData;
};
const script = (html: string) => html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));

/** 新項目（destStop・higashiStops）なしの小さなデータ */
const base = (): BusRoutesData => ({
  meta: {
    generatedAt: "2026-10-31T16:30:00.000Z", // 日本時間では 11/01
    failures: [{ dest: "gion", terminus: "博多駅", reason: "停留所名検索で一致する停留所なし" }],
  },
  routes: [
    {
      dest: "gion", number: "9", kind: "普通", terminus: "能古渡船場", queriedTerminus: "箱崎三丁目", direction: "to_dest",
      morning: { departures7to9: 2, capped: false, from: "箱崎三丁目" },
      stops: [
        { name: "箱崎三丁目", lat: 33.6199377736596, lng: 130.42315062495703 },
        { name: "通過する停留所", lat: 33.61, lng: 130.42, passThrough: true },
        { name: "座標なし", lat: null, lng: null },
        { name: "祇園町", lat: 33.5940762, lng: 130.4144121 },
        { name: "目的より先", lat: 33.58, lng: 130.4 },
      ],
      destIndex: 3,
    },
    {
      dest: "higashi", number: "29N", kind: "都市高", terminus: "博多駅", direction: "to_dest",
      morning: { departures7to9: 10, capped: true, from: "香椎" },
      stops: [{ name: "香椎", lat: 33.66, lng: 130.44 }, { name: "東光二丁目", lat: 33.5967, lng: 130.4287 }],
      destIndex: 1,
    },
    {
      dest: "gion", number: "3", kind: "普通", terminus: "早良高校", direction: "from_dest",
      stops: [{ name: "祇園町", lat: 33.594, lng: 130.414 }, { name: "早良高校", lat: 33.5, lng: 130.35 }],
      destIndex: 0,
    },
  ],
  stops: [
    { name: "箱崎三丁目", lat: 33.6199377736596, lng: 130.42315062495703, dests: ["gion"], numbers: ["9"] },
    { name: "香椎", lat: 33.66, lng: 130.44, dests: ["gion", "higashi"], numbers: ["29N"] },
    { name: "席田会館", lat: null, lng: null, dests: ["gion"], numbers: ["1"] },
  ],
});

test("取得日は日本時間の日付", () => {
  assert.equal(jstDate("2026-10-31T13:38:40.516Z"), "2026-10-31");
  assert.equal(jstDate("2026-10-31T16:30:00.000Z"), "2026-11-01");
  assert.equal(jstDate(undefined), "不明");
});

test("埋め込みデータ: to_dest の線だけ・目的地まで・座標なしを除き小数5桁", () => {
  const d = toBusMapData(base());
  assert.equal(d.date, "2026-11-01");
  assert.equal(d.routes.length, 2, "from_dest は線にしない");
  const r9 = d.routes[0]!;
  assert.deepEqual(r9.p, [[33.61994, 130.42315], [33.61, 130.42], [33.59408, 130.41441]], "通過は点に使い・座標なしと目的より先は除く");
  assert.equal(r9.f, "箱崎三丁目");
  assert.equal(r9.m, 2);
  assert.equal(r9.c, false);
  assert.equal(r9.s, undefined);
  assert.equal(d.routes[1]!.c, true);
  assert.deepEqual(d.stops.map((s) => [s.n, s.g, s.h]), [["箱崎三丁目", 1, 0], ["香椎", 1, 1]]);
  assert.deepEqual(d.noCoord, ["席田会館"]);
  assert.deepEqual(d.failures, [{ d: "gion", t: "博多駅", r: "停留所名検索で一致する停留所なし" }]);
});

test("新項目（destStop・higashiStops）があれば埋め込む", () => {
  const raw = base();
  raw.routes[1]!.destStop = "東比恵二丁目";
  raw.stops[1]!.higashiStops = ["東光二丁目", "東比恵二丁目"];
  const d = toBusMapData(raw);
  assert.equal(d.routes[1]!.s, "東比恵二丁目");
  assert.deepEqual(d.stops[1]!.x, ["東光二丁目", "東比恵二丁目"]);
  assert.equal(d.stops[0]!.x, undefined);
  const html = renderBusRoutesDashboard(raw);
  assert.doesNotThrow(() => new Function(script(html)));
  assert.deepEqual(embedded(html).stops[1]!.x, ["東光二丁目", "東比恵二丁目"]);
  assert.equal(embedded(html).routes[1]!.s, "東比恵二丁目");
});

test("/listings/bus の HTML: 地図・チェックボックス・凡例・目印・注意書き・失敗一覧・出典", () => {
  const html = renderBusRoutesDashboard(base());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /noindex/);
  assert.ok(html.includes(`cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.js`));
  assert.ok(html.includes('<div id="map">'));
  assert.ok(html.includes('id="cb-gion" checked'));
  assert.ok(html.includes('id="cb-higashi" checked'));
  assert.ok(html.includes('id="legend"'));
  assert.ok(html.includes("西鉄の時刻表（2026-11-01 取得）から、乗り換えなしで着く便を集めたもの。"));
  assert.ok(html.includes("行先が博多駅などで取れなかった便は入っていない（一覧は下）。"));
  assert.match(html, /<details id="failures">[\s\S]*職場行き・博多駅: 停留所名検索で一致する停留所なし[\s\S]*座標なし: 席田会館[\s\S]*<\/details>/);
  assert.ok(html.includes("バスの路線・停留所: 西日本鉄道 にしてつ時刻表（私的利用）。一部の停留所の位置は 国土数値情報（バス停留所データ）国土交通省 2022年度 を加工"));
  assert.ok(html.includes("OpenStreetMap"));
  const d = embedded(html) as BusMapData & { places: { work: { lat: number }; school: { radiusM: number } } };
  assert.equal(d.places.work.lat, 33.59468);
  assert.equal(d.places.school.radiusM, 500);
  const s = script(html);
  for (const k of ["L.polyline", "L.circleMarker", "L.circle(", "dashArray", "本以上", "職場へ直通", "学校へ直通", "系統: "]) assert.ok(s.includes(k), k);
});

test("実データ（src/data/bus-routes.json）で描け、埋め込みは 400KB 以下・スクリプトは構文として正しい", () => {
  const html = renderBusRoutesDashboard();
  const d = embedded(html);
  assert.ok(d.routes.length > 50, "線");
  assert.ok(d.stops.length > 300, "停留所");
  assert.ok(d.routes.every((r) => r.d === "gion" || r.d === "higashi"));
  assert.ok(d.stops.some((s) => s.g && s.h), "両方に直通の停留所がある");
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  const kb = Buffer.byteLength(html.match(/var DATA = (\{.*?\});\n/s)![1]!) / 1024;
  assert.ok(kb < 400, `埋め込み ${kb.toFixed(0)}KB`);
  // テンプレートへの展開漏れが無い
  const s = script(html);
  assert.ok(!s.includes("`"), "バッククォートを含まない");
  assert.doesNotThrow(() => new Function(s));
});

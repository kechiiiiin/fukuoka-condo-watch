// 「バスで職場・学校へ直通」の距離判定（src/bus-access.ts）。
// 5 分 = 直線 320m（64m/分）の境目・分の切り上げ・行先ごとの最寄り・格子で取りこぼさないことを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import busRoutes from "../src/data/bus-routes.json" with { type: "json" };
import {
  BUS_WALK_M_PER_MIN,
  BUS_WALK_MAX_M,
  BUS_WALK_MAX_MIN,
  BusStopIndex,
  busStopIndex,
  type BusRoutesInput,
  directStopsFrom,
  distanceM,
  walkMinutesFromMeters,
} from "../src/bus-access.ts";

/** 緯度 lat の地点から北へ m メートル動いた緯度（経度は変えない） */
const north = (lat: number, m: number) => lat + m / 111_195; // 6,371,008.8m × π / 180 ≒ 111,195m / 度

test("5 分の定義: 64m/分 × 5 = 直線 320m（SUUMO の道のり 80m/分を 2 割控えめ）", () => {
  assert.equal(BUS_WALK_M_PER_MIN, 64);
  assert.equal(BUS_WALK_MAX_MIN, 5);
  assert.equal(BUS_WALK_MAX_M, 320);
  assert.equal(BUS_WALK_M_PER_MIN, 80 * 0.8);
});

test("分の計算: 直線距離 ÷ 64m を切り上げ（320m = 5 分・0m でも 1 分）", () => {
  assert.equal(walkMinutesFromMeters(0), 1);
  assert.equal(walkMinutesFromMeters(1), 1);
  assert.equal(walkMinutesFromMeters(64), 1);
  assert.equal(walkMinutesFromMeters(64.5), 2);
  assert.equal(walkMinutesFromMeters(128), 2);
  assert.equal(walkMinutesFromMeters(150), 3);
  assert.equal(walkMinutesFromMeters(319), 5);
  assert.equal(walkMinutesFromMeters(320), 5, "320m ちょうどで 5 分");
  assert.equal(walkMinutesFromMeters(321), 6);
});

test("距離: 大円距離（緯度 0.001° ≒ 111m・祇園町〜東光二丁目 ≒ 1.4km）", () => {
  assert.ok(Math.abs(distanceM(33.59, 130.41, 33.591, 130.41) - 111.2) < 0.5);
  const d = distanceM(33.5940762, 130.4144121, 33.5967047, 130.428745);
  assert.ok(d > 1300 && d < 1450, String(d));
});

const RAW: BusRoutesInput = {
  routes: [
    // 13 番: A → B → 祇園町（destIndex 2）。A・B から職場へ直通
    { dest: "gion", number: "13", direction: "to_dest", destIndex: 2, stops: [{ name: "A" }, { name: "B" }, { name: "祇園町" }] },
    // 39 番: B → 東光二丁目（学校）。B から学校へ直通
    { dest: "higashi", number: "39", direction: "to_dest", destIndex: 1, stops: [{ name: "B" }, { name: "東光二丁目" }] },
    // 逆向きは数えない
    { dest: "gion", number: "99", direction: "from_dest", destIndex: 0, stops: [{ name: "祇園町" }, { name: "A" }] },
  ],
  stops: [
    { name: "A", lat: 33.55, lng: 130.37, dests: ["gion"], numbers: ["13", "99"] },
    { name: "B", lat: 33.56, lng: 130.38, dests: ["gion", "higashi"], numbers: ["13", "39"], higashiStops: ["東光二丁目"] },
    { name: "座標なし", lat: null, lng: null, dests: ["gion"], numbers: ["1"] },
  ],
};

test("直通バス停: 行先ごとに分け、系統番号は行先別（合算の numbers を混ぜない）・座標なしは除く", () => {
  const s = directStopsFrom(RAW);
  assert.deepEqual(
    s.map((x) => [x.name, x.dest, x.numbers, x.alightAt]),
    [
      ["A", "gion", ["13"], []],
      ["B", "gion", ["13"], []],
      ["B", "higashi", ["39"], ["東光二丁目"]],
    ],
  );
  const idx = new BusStopIndex(s);
  assert.equal(idx.placeCount, 2, "B は職場・学校の両方だが 1 か所と数える");
});

test("最寄り: 320m 以内だけ・行先ごとに一番近いもの・境目（320m は入る / 321m は入らない）", () => {
  const idx = new BusStopIndex(directStopsFrom(RAW));
  const near = idx.nearest(north(33.56, -200), 130.38); // B の 200m 南
  assert.equal(near.gion?.name, "B");
  assert.equal(near.gion?.minutes, 4); // 200 / 64 = 3.1 → 4 分
  assert.deepEqual(near.gion?.numbers, ["13"]);
  assert.equal(near.higashi?.name, "B");
  assert.deepEqual(near.higashi?.alightAt, ["東光二丁目"]);

  const at320 = idx.nearest(north(33.56, -319.9), 130.38);
  assert.equal(at320.gion?.name, "B", "320m 以内は入る");
  assert.equal(at320.gion?.minutes, 5);
  const at321 = idx.nearest(north(33.56, -321), 130.38);
  assert.equal(at321.gion, null, "321m は入らない");
  assert.equal(at321.higashi, null);
  assert.equal(idx.hasAny(north(33.56, -321), 130.38), false);
  assert.equal(idx.hasAny(north(33.56, -100), 130.38), true);

  // A（職場だけ）の近く: 学校は null
  const nearA = idx.nearest(33.5505, 130.3702);
  assert.equal(nearA.gion?.name, "A");
  assert.equal(nearA.higashi, null);
});

test("hasBoth: 職場・学校の両方へ徒歩5分以内でないと true にならない（AND）", () => {
  const idx = new BusStopIndex(directStopsFrom(RAW));
  // A は職場だけ（学校は 320m 以内に無い）→ 片方だけ近いので false
  assert.equal(idx.hasBoth(33.5505, 130.3702), false);
  // B は職場・学校の両方に直通（同じバス停）→ true
  assert.equal(idx.hasBoth(north(33.56, -100), 130.38), true);
  // どちらにも当たらない地点 → false
  assert.equal(idx.hasBoth(north(33.56, -321), 130.38), false);

  // 職場行き・学校行きが別々のバス停でも、両方 320m 以内なら true
  const gionOnly = { name: "G", lat: 33.6, lng: 130.4, dest: "gion" as const, numbers: ["1"], alightAt: [] };
  const higashiOnly = { name: "H", lat: 33.6002, lng: 130.4002, dest: "higashi" as const, numbers: ["2"], alightAt: [] };
  const idx2 = new BusStopIndex([gionOnly, higashiOnly]);
  assert.equal(idx2.hasBoth(33.6, 130.4), true, "別々のバス停でも両方近ければ true");
  assert.equal(idx2.hasAny(33.6, 130.4), true);
});

test("格子で絞っても総当たりと同じ答え（実データ・福岡市内の格子点 400 点）", () => {
  const stops = directStopsFrom(busRoutes as unknown as BusRoutesInput);
  assert.ok(stops.length > 500, `直通バス停（行先別）が ${stops.length} 件`);
  const idx = new BusStopIndex(stops);
  let hits = 0;
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const lat = 33.52 + i * 0.006;
      const lng = 130.33 + j * 0.008;
      const got = idx.nearest(lat, lng);
      for (const d of ["gion", "higashi"] as const) {
        let best: { name: string; m: number } | null = null;
        for (const s of stops) {
          if (s.dest !== d) continue;
          const m = distanceM(lat, lng, s.lat, s.lng);
          if (m <= BUS_WALK_MAX_M && (!best || m < best.m)) best = { name: s.name, m };
        }
        assert.equal(got[d]?.meters ?? null, best ? Math.round(best.m) : null, `${lat},${lng} ${d}`);
        if (best) hits++;
      }
    }
  }
  assert.ok(hits > 20, `当たりが ${hits} 件（判定が空振りしていない）`);
});

test("実データの格子: 座標の無い停留所は数えない・場所の数は約 600", () => {
  const idx = busStopIndex();
  const raw = busRoutes as unknown as BusRoutesInput;
  const withCoord = raw.stops.filter((s) => s.lat !== null && s.lng !== null).length;
  assert.ok(idx.placeCount <= withCoord && idx.placeCount > 500, String(idx.placeCount));
  assert.ok(idx.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)));
  assert.equal(busStopIndex(), idx, "格子は 1 回だけ作って使い回す");
});

// スコア計算（src/scoring.ts）のテスト。本番 D1 の実データの形（2026-09-14 時点）を模した入力で確かめる
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  futurePopChange,
  MIN_CANDIDATES,
  pickLatestQuarter,
  rentScores,
  stationPassengerChange,
  wardSellResults,
  windowBounds,
  type Windowed,
} from "../src/scoring.ts";

const qi = (year: number, quarter: number) => year * 4 + quarter - 1;

test("直近の四半期: 全市区町村に入っている最新の四半期を選ぶ", () => {
  const rows = [
    { qi: qi(2025, 3), areas: 22 },
    { qi: qi(2025, 4), areas: 22 },
    { qi: qi(2026, 1), areas: 22 },
  ];
  assert.equal(pickLatestQuarter(rows), qi(2026, 1));
});

test("直近の四半期: 一部の市区町村にしか入っていない新しい四半期は基準にしない", () => {
  // 日次取り込みの途中で 2026Q2 が 3 市区町村だけに入った状態
  const rows = [
    { qi: qi(2026, 2), areas: 3 },
    { qi: qi(2026, 1), areas: 22 },
    { qi: qi(2025, 4), areas: 21 },
  ];
  assert.equal(pickLatestQuarter(rows), qi(2026, 1));
  // 半分以上そろえば進める
  assert.equal(pickLatestQuarter([{ qi: qi(2026, 2), areas: 11 }, ...rows.slice(1)]), qi(2026, 2));
});

test("直近の四半期: データが無ければ null・件数 0 の四半期（空の未来の四半期）は無視", () => {
  assert.equal(pickLatestQuarter([]), null);
  assert.equal(pickLatestQuarter([{ qi: qi(2026, 3), areas: 0 }]), null);
  assert.equal(pickLatestQuarter([{ qi: qi(2026, 3), areas: 0 }, { qi: qi(2026, 1), areas: 7 }]), qi(2026, 1));
});

test("直近8四半期と前8四半期の窓: 境目がずれず、成約価格の開始 2021Q1 より前にはみ出さない", () => {
  const L = qi(2026, 1);
  const w = windowBounds(L);
  // 直近 = 2024Q2..2026Q1、前期 = 2022Q2..2024Q1（どちらも 8 四半期）
  assert.equal(w.recentFirst, qi(2024, 2));
  assert.equal(w.priorFirst, qi(2022, 2));
  const recent = [];
  const prior = [];
  for (let q = qi(2021, 1); q <= L; q++) {
    if (q > w.recentAfter) recent.push(q);
    else if (q > w.priorAfter) prior.push(q);
  }
  assert.equal(recent.length, 8);
  assert.equal(prior.length, 8);
  assert.ok(prior[0]! >= qi(2021, 1));
});

const win = (nRecent: number, medRecent: number | null, nPrior: number, medPrior: number | null): Windowed => ({
  nRecent,
  medRecent,
  nPrior,
  medPrior,
});

test("売りやすさ: データの無い市区町村は データなし（順位の母数に入れない）", () => {
  const windows = new Map<string, Windowed>([
    ["40131", win(100, 400000, 90, 380000)],
    ["40132", win(200, 500000, 180, 450000)],
    ["40133", win(300, 600000, 280, 520000)], // 件数も価格維持も最上位
    ["40219", win(0, null, 0, null)], // 取引価格を選んだときの近郊（行はあるが 0 件）
  ]);
  const codes = ["40131", "40132", "40133", "40219", "40348"]; // 40348 = 久山町（行そのものが無い）
  const r = wardSellResults(codes, windows);
  assert.deepEqual(r.get("40348"), { score: null, status: "no_data" });
  assert.deepEqual(r.get("40219"), { score: null, status: "no_data" });
  // 順位は 3 区だけで付く（データなしを 0 点として混ぜると最下位の区が底上げされる）
  assert.equal(r.get("40131")?.status, "ok");
  assert.equal(r.get("40131")?.score, Math.round(100 * (0.5 * (0.5 / 3) + 0.5 * (0.5 / 3))));
  assert.equal(r.get("40133")?.score, Math.round(100 * (0.5 * (2.5 / 3) + 0.5 * (2.5 / 3))));
});

test("売りやすさ: 直近か前期が空なら 件数不足", () => {
  const windows = new Map<string, Windowed>([
    ["a", win(10, 300000, 10, 290000)],
    ["b", win(12, 310000, 11, 300000)],
    ["c", win(14, 320000, 12, 300000)],
    ["d", win(3, 250000, 0, null)],
  ]);
  const r = wardSellResults(["a", "b", "c", "d"], windows);
  assert.deepEqual(r.get("d"), { score: null, status: "insufficient" });
  assert.equal(r.get("a")?.status, "ok");
});

test("売りやすさ: 候補が 3 未満なら 比較対象不足（取引価格の近郊 = 春日市だけ、で 50 点を付けない）", () => {
  assert.equal(MIN_CANDIDATES, 3);
  const windows = new Map<string, Windowed>([["40218", win(25, 300000, 20, 280000)]]);
  const codes = ["40217", "40218", "40219"];
  const r = wardSellResults(codes, windows);
  assert.deepEqual(r.get("40218"), { score: null, status: "few_candidates" });
  assert.deepEqual(r.get("40217"), { score: null, status: "no_data" });
});

test("将来人口の増減: PTN_2020 由来の 2020 を基準に 2040 と比べる", () => {
  const v = futurePopChange({ "2020": 200000, "2025": 205000, "2040": 210000, "2070": 150000 });
  assert.deepEqual(v, { value: 5, from: "2020", to: "2040" });
});

test("将来人口の増減: 2020 が無い（旧 load-geo の取り込み）ときは最も古い年を基準にする・2040 が無ければ null", () => {
  assert.deepEqual(futurePopChange({ "2025": 100000, "2030": 99000, "2040": 90000 }), { value: -10, from: "2025", to: "2040" });
  assert.equal(futurePopChange({ "2020": 100000, "2025": 99000 }), null);
  assert.equal(futurePopChange({}), null);
});

test("駅乗降客数の増減: 両方の年に値がある駅だけで合計する・ひも付いていない駅は使わない", () => {
  const rows = [
    { key: "A", area_code: "40133", year: 2019, passengers: 1000 },
    { key: "A", area_code: "40133", year: 2023, passengers: 900 },
    { key: "B", area_code: "40133", year: 2019, passengers: 500 },
    { key: "B", area_code: "40133", year: 2023, passengers: 600 },
    { key: "NEW", area_code: "40133", year: 2023, passengers: 5000 }, // 2023 開業（母数に入れない）
    { key: "C", area_code: null, year: 2019, passengers: 100 },
    { key: "C", area_code: null, year: 2023, passengers: 300 },
    { key: "D", area_code: "40348", year: 2019, passengers: null },
  ];
  const m = stationPassengerChange(rows);
  assert.deepEqual(m.get("40133"), { value: 0, baseYear: 2019, latestYear: 2023, stations: 2 });
  assert.equal(m.has("40348"), false);
  assert.equal(m.size, 1);
});

test("貸しやすさ: 取れている指標がすべて効き、used に並ぶ", () => {
  const comps = [
    { id: "future_pop_change", weight: 20, higherIsBetter: true },
    { id: "vacant_rental_rate", weight: 25, higherIsBetter: false },
    { id: "small_unit_share", weight: 20, higherIsBetter: true },
    { id: "station_passengers_change", weight: 10, higherIsBetter: true },
  ];
  const values = new Map<string, Record<string, number | null>>([
    ["x", { future_pop_change: 5, vacant_rental_rate: null, small_unit_share: 50, station_passengers_change: -5 }],
    ["y", { future_pop_change: -5, vacant_rental_rate: null, small_unit_share: 10, station_passengers_change: 5 }],
    ["z", { future_pop_change: 0, vacant_rental_rate: null, small_unit_share: null, station_passengers_change: null }], // 取引も駅も無い町
  ]);
  const { byArea, active } = rentScores(["x", "y", "z"], values, comps);
  assert.deepEqual([...active].sort(), ["future_pop_change", "small_unit_share", "station_passengers_change"]);
  assert.deepEqual(byArea.get("x")?.used, ["future_pop_change", "small_unit_share", "station_passengers_change"]);
  // x: 将来人口 2.5/3・小さい住戸 0.75・駅 0.25 → (20×5/6 + 20×0.75 + 10×0.25) / 50
  assert.equal(byArea.get("x")?.score, Math.round((100 * (20 * (2.5 / 3) + 20 * 0.75 + 10 * 0.25)) / 50));
  // z は将来人口だけで採点される（重みを割り直す）
  assert.deepEqual(byArea.get("z")?.used, ["future_pop_change"]);
  assert.equal(byArea.get("z")?.score, 50);
});

test("貸しやすさ: 値のある市区町村が 1 つだけの指標は使わない", () => {
  const comps = [
    { id: "a", weight: 10, higherIsBetter: true },
    { id: "b", weight: 10, higherIsBetter: true },
  ];
  const values = new Map<string, Record<string, number | null>>([
    ["x", { a: 1, b: 7 }],
    ["y", { a: 2, b: null }],
  ]);
  const { byArea, active } = rentScores(["x", "y"], values, comps);
  assert.deepEqual([...active], ["a"]);
  assert.deepEqual(byArea.get("x")?.used, ["a"]);
});

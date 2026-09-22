// 新築ビューの純粋関数（src/new-listing-view.ts）: 条件・新築プレミアム・並べ替え
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUsedBaseline,
  matchesNewFilters,
  newUnitPriceForPremium,
  type NewListingRow,
  parseNewFilters,
  premiumFor,
  sortNew,
} from "../src/new-listing-view.ts";
import { isAreaCode } from "../src/wards.ts";

function row(p: Partial<NewListingRow>): NewListingRow {
  return {
    external_id: "1", listing_type: "project", ward_code: "40218", building_name: "x", address: "春日市春日２",
    line_name: null, station_name: null, walk_minutes: null, bus: 0, price_min: 45_000_000, price_max: 50_000_000,
    price_undecided: 0, price_tentative: 0, area_min: 65, area_max: 80, unit_price_min: 600_000, unit_price_max: 700_000,
    floor_plans: null, sale_status: "first_come", sale_label: null, delivery_text: null, delivery_ym: null, delivery_immediate: 0,
    url: null, first_seen: "2026-09-27", last_seen: "2026-09-27", first_price_min: null, first_price_max: null,
    price_change_count: 0, delisted_on: null, ...p,
  };
}

test("条件: 既定は 価格下限 ≤ 4,800万・面積上限 ≥ 70㎡・価格未定は含める・掲載終了は除く", () => {
  const f = parseNewFilters(new URLSearchParams(""), isAreaCode);
  assert.equal(f.priceMaxMan, 4800);
  assert.equal(f.areaMin, 70);
  assert.ok(matchesNewFilters(row({}), f));
  assert.ok(matchesNewFilters(row({ price_min: 48_000_000 }), f), "ちょうど 4,800万は入る");
  assert.ok(!matchesNewFilters(row({ price_min: 48_100_000 }), f));
  assert.ok(!matchesNewFilters(row({ area_max: 69.9 }), f));
  assert.ok(matchesNewFilters(row({ price_min: null, price_max: null }), f), "価格未定");
  assert.ok(!matchesNewFilters(row({ price_min: null }), parseNewFilters(new URLSearchParams("undecided=0"), isAreaCode)));
  assert.ok(!matchesNewFilters(row({ delisted_on: "2026-10-04" }), f));
  assert.ok(matchesNewFilters(row({ delisted_on: "2026-10-04" }), parseNewFilters(new URLSearchParams("ended=1"), isAreaCode)));
  const all = parseNewFilters(new URLSearchParams("all=1"), isAreaCode);
  assert.ok(matchesNewFilters(row({ price_min: 200_000_000, area_max: 30 }), all));
  const units = parseNewFilters(new URLSearchParams("type=unit"), isAreaCode);
  assert.ok(!matchesNewFilters(row({}), units));
  const muni = parseNewFilters(new URLSearchParams("muni=40133"), isAreaCode);
  assert.ok(!matchesNewFilters(row({}), muni));
  assert.equal(parseNewFilters(new URLSearchParams("sort=bogus"), isAreaCode).sort, "newest");
});

test("新築の㎡単価: 幅の中央、上限が無ければ下限、価格未定は null", () => {
  assert.equal(newUnitPriceForPremium({ unit_price_min: 600_000, unit_price_max: 700_000 }), 650_000);
  assert.equal(newUnitPriceForPremium({ unit_price_min: 600_000, unit_price_max: null }), 600_000);
  assert.equal(newUnitPriceForPremium({ unit_price_min: null, unit_price_max: null }), null);
});

test("新築プレミアム: 地区が足りれば地区、足りなければ市区町村、どちらも足りなければ出さない", () => {
  const rows = [
    // 春日市 春日: 8 件（地区の最低件数ちょうど）中央値 50 万
    ...Array.from({ length: 8 }, (_, i) => ({ ward_code: "40218", district_name: "春日", unit_price: 460_000 + i * 10_000 + (i >= 4 ? 10_000 : 0) })),
    // 春日市 その他の地区: 12 件 → 市区町村は 20 件
    ...Array.from({ length: 12 }, () => ({ ward_code: "40218", district_name: "小倉東", unit_price: 400_000 })),
    // 大野城市: 5 件だけ
    ...Array.from({ length: 5 }, () => ({ ward_code: "40219", district_name: "白木原", unit_price: 450_000 })),
  ];
  const b = buildUsedBaseline(rows);
  const name = (c: string) => ({ "40218": "春日市", "40219": "大野城市" })[c] ?? null;
  const d = premiumFor(650_000, "40218", "春日市春日２", b, name)!;
  assert.equal(d.level, "district");
  assert.equal(d.areaName, "春日");
  assert.equal(d.n, 8);
  assert.equal(d.usedUnitMedian, 500_000);
  assert.equal(d.value, 0.3);
  // 地区（宝町）の成約が無い → 市区町村（20 件）
  const m = premiumFor(650_000, "40218", "春日市宝町３", b, name)!;
  assert.equal(m.level, "municipality");
  assert.equal(m.areaName, "春日市");
  assert.equal(m.n, 20);
  // 大野城市は 5 件しか無い → 出さない
  assert.equal(premiumFor(650_000, "40219", "大野城市白木原１", b, name), null);
  // 価格未定
  assert.equal(premiumFor(null, "40218", "春日市春日２", b, name), null);
});

test("並べ替え: 値の無いものは末尾", () => {
  const it = (name: string, p: Partial<{ firstSeen: string; priceMin: number | null; deliveryYm: string | null; deliveryImmediate: boolean; premium: number | null }>) => ({
    buildingName: name,
    firstSeen: p.firstSeen ?? "2026-09-27",
    priceMin: p.priceMin ?? null,
    deliveryYm: p.deliveryYm ?? null,
    deliveryImmediate: p.deliveryImmediate ?? false,
    premium: p.premium === undefined || p.premium === null ? null : { value: p.premium, level: "district" as const, areaName: "", n: 8, usedUnitMedian: 1, newUnit: 1 },
  });
  const xs = [
    it("a", { firstSeen: "2026-09-20", priceMin: 5000, premium: 0.4, deliveryYm: "2028-03" }),
    it("b", { firstSeen: "2026-09-27", priceMin: null, premium: null, deliveryImmediate: true }),
    it("c", { firstSeen: "2026-09-13", priceMin: 4000, premium: 0.1, deliveryYm: "2027-02" }),
  ];
  assert.deepEqual(sortNew(xs, "newest").map((x) => x.buildingName), ["b", "a", "c"]);
  assert.deepEqual(sortNew(xs, "premium").map((x) => x.buildingName), ["c", "a", "b"]);
  assert.deepEqual(sortNew(xs, "price").map((x) => x.buildingName), ["c", "a", "b"]);
  assert.deepEqual(sortNew(xs, "delivery").map((x) => x.buildingName), ["b", "c", "a"]);
});

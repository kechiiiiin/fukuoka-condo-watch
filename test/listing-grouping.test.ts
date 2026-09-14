// 「条件に合う新着・掲載中の物件」ビュー（src/listing-picks.ts）のうち D1 に触らない純粋関数のテスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PICK_FILTERS,
  groupListings,
  matchesConditions,
  normalizeBuildingName,
  parseFloorPlan,
  parseMunicipalities,
  parsePickFilters,
  sortGroupsNewestFirst,
  type ListingPickRow,
} from "../src/listing-grouping.ts";

function row(over: Partial<ListingPickRow> = {}): ListingPickRow {
  return {
    source: "suumo:ms-chuko",
    external_id: "id1",
    ward_code: "40132",
    district_name: "博多区",
    building_name: "アンピール空港南",
    building_year: 2005,
    built_month: 4,
    area_sqm: 65.5,
    floor_plan: "3LDK",
    line_name: "地下鉄空港線",
    station_name: "博多",
    walk_minutes: 8,
    bus: 0,
    address: "福岡県福岡市博多区東平尾",
    url: "https://suumo.jp/ms/chuko/fukuoka/sc_hakata/nc_1",
    first_seen: "2026-09-10",
    last_seen: "2026-09-14",
    current_price: 32000000,
    first_price: 32800000,
    price_cut_count: 1,
    relisted_count: 0,
    ...over,
  };
}

test("建物名の正規化: 全角/半角・空白・記号の違いを吸収する", () => {
  assert.equal(normalizeBuildingName("アンピール空港南"), normalizeBuildingName("アンピール　空港南"));
  assert.equal(normalizeBuildingName("ｱﾝﾋﾟｰﾙ空港南"), normalizeBuildingName("アンピール空港南"));
  assert.equal(normalizeBuildingName(null), "");
  assert.equal(normalizeBuildingName(""), "");
});

test("間取りの解析: 部屋数と LDK/DK タイプ", () => {
  assert.deepEqual(parseFloorPlan("3LDK"), { rooms: 3, hasL: true });
  assert.deepEqual(parseFloorPlan("4LDK+S"), { rooms: 4, hasL: true });
  assert.deepEqual(parseFloorPlan("3DK"), { rooms: 3, hasL: false });
  assert.deepEqual(parseFloorPlan("1K"), { rooms: 1, hasL: false });
  assert.deepEqual(parseFloorPlan(null), { rooms: null, hasL: false });
});

test("グルーピング: アンピール空港南が11件の別 external_id で重複掲載 → 1グループにまとまる", () => {
  const rows: ListingPickRow[] = Array.from({ length: 11 }, (_, i) =>
    row({
      source: `agency-${i}`,
      external_id: `nc_${1000 + i}`,
      url: `https://suumo.jp/ms/chuko/fukuoka/sc_hakata/nc_${1000 + i}/`,
      // 業者ごとに表記ゆれ（全角空白・末尾スペース）があっても同じ建物として扱う
      building_name: i % 2 === 0 ? "アンピール空港南" : "アンピール　空港南　",
      current_price: 32000000 + i * 100000, // 業者ごとに多少の価格差
      first_seen: i === 0 ? "2026-09-01" : "2026-09-10",
    }),
  );
  const groups = groupListings(rows);
  assert.equal(groups.length, 1);
  const g = groups[0]!;
  assert.equal(g.count, 11);
  assert.equal(g.buildingName, "アンピール空港南");
  assert.equal(g.minPrice, 32000000);
  assert.equal(g.maxPrice, 33000000);
  assert.equal(g.urls.length, 11);
  assert.equal(g.earliestFirstSeen, "2026-09-01");
  assert.equal(g.latestFirstSeen, "2026-09-10");
});

test("グルーピング: 建物名・間取り・築年が同じでも専有面積が大きく違うものはマージしない", () => {
  const rows: ListingPickRow[] = [
    row({ external_id: "a", area_sqm: 65.0 }),
    row({ external_id: "b", area_sqm: 65.4 }), // ±0.5 以内 → 同じグループ
    row({ external_id: "c", area_sqm: 80.0 }), // 大きく違う → 別グループ（別の部屋タイプ）
  ];
  const groups = groupListings(rows);
  assert.equal(groups.length, 2);
  const sizes = groups.map((g) => g.count).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test("グルーピング: 建物名が読めない行は他の無名物件と誤って混ざらない（external_id 単位で単独グループ）", () => {
  const rows: ListingPickRow[] = [
    row({ external_id: "x", building_name: null }),
    row({ external_id: "y", building_name: null, area_sqm: 65.5 }), // 面積が同じでも別物件のはず
  ];
  const groups = groupListings(rows);
  assert.equal(groups.length, 2);
});

test("新着順ソート: latestFirstSeen が新しい順、同着は価格が安い順", () => {
  const groups = groupListings([
    row({ external_id: "old", first_seen: "2026-09-01", current_price: 30000000 }),
    row({ external_id: "newA", building_name: "ビルA", first_seen: "2026-09-12", current_price: 35000000 }),
    row({ external_id: "newB", building_name: "ビルB", first_seen: "2026-09-12", current_price: 31000000 }),
  ]);
  const sorted = sortGroupsNewestFirst(groups);
  assert.deepEqual(
    sorted.map((g) => g.listings[0]!.external_id),
    ["newB", "newA", "old"],
  );
});

test("既定条件: 3600万以下・65㎡以上・3LDK以上・築25年以内・徒歩10分以内（バス便は除外）", () => {
  const f = parsePickFilters(new URLSearchParams(), () => true);
  assert.deepEqual(f, { ...DEFAULT_PICK_FILTERS });
  const nowYear = 2026;
  const today = "2026-09-14";
  assert.equal(matchesConditions(row(), f, nowYear, today), true);
  assert.equal(matchesConditions(row({ current_price: 36000001 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ area_sqm: 64.9 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ floor_plan: "2LDK" }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ floor_plan: "3DK" }), f, nowYear, today), false, "3DKは既定でno");
  assert.equal(matchesConditions(row({ building_year: 2000 }), f, nowYear, today), false, "築26年は既定でno（25年超）");
  assert.equal(matchesConditions(row({ building_year: 2001 }), f, nowYear, today), true, "築25年はyes");
  assert.equal(matchesConditions(row({ walk_minutes: 11 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ bus: 1, walk_minutes: null }), f, nowYear, today), false, "バス便は既定で除外");
});

test("トグル: includeDK・includeBus で条件を緩められる", () => {
  const base = parsePickFilters(new URLSearchParams(), () => true);
  const withDk = { ...base, includeDK: true };
  const withBus = { ...base, includeBus: true };
  const today = "2026-09-14";
  assert.equal(matchesConditions(row({ floor_plan: "3DK" }), withDk, 2026, today), true);
  assert.equal(matchesConditions(row({ bus: 1, walk_minutes: null }), withBus, 2026, today), true);
});

test("新着のみ: freshOnly が true だと first_seen が直近 freshDays 日以内だけ", () => {
  const f = { ...parsePickFilters(new URLSearchParams(), () => true), freshOnly: true };
  const today = "2026-09-14";
  assert.equal(matchesConditions(row({ first_seen: "2026-09-10" }), f, 2026, today), true);
  assert.equal(matchesConditions(row({ first_seen: "2026-09-06" }), f, 2026, today), false);
});

test("市区町村の絞り込み: muni クエリで対象コードだけ通す", () => {
  const isAreaCode = (v: string) => ["40131", "40132"].includes(v);
  assert.equal(parseMunicipalities(new URLSearchParams(""), isAreaCode), null);
  assert.deepEqual(parseMunicipalities(new URLSearchParams("muni=40132,40999"), isAreaCode), ["40132"]);
  assert.equal(parseMunicipalities(new URLSearchParams("muni=40999"), isAreaCode), null);

  const f = parsePickFilters(new URLSearchParams("muni=40131"), isAreaCode);
  const today = "2026-09-14";
  assert.equal(matchesConditions(row({ ward_code: "40132" }), f, 2026, today), false);
  assert.equal(matchesConditions(row({ ward_code: "40131" }), f, 2026, today), true);
});

test("クエリパラメータで条件を上書きできる", () => {
  const f = parsePickFilters(new URLSearchParams("pmax=5000&amin=50&plan=2&age=30&walk=15&dk=1&bus=1&fresh=1"), () => true);
  assert.equal(f.priceMaxMan, 5000);
  assert.equal(f.areaMin, 50);
  assert.equal(f.planRoomsMin, 2);
  assert.equal(f.ageMax, 30);
  assert.equal(f.walkMax, 15);
  assert.equal(f.includeDK, true);
  assert.equal(f.includeBus, true);
  assert.equal(f.freshOnly, true);
});

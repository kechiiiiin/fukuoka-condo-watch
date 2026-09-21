// 「条件に合う新着・掲載中の物件」ビュー（src/listing-picks.ts）のうち D1 に触らない純粋関数のテスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PICK_FILTERS,
  districtNameFromAddress,
  groupListings,
  indexDistrictWindows,
  matchesConditions,
  normalizeBuildingName,
  parseFloorPlan,
  parseMunicipalities,
  parsePickFilters,
  parsePickSort,
  pickRetention,
  sortGroupsByRetention,
  sortGroupsNewestFirst,
  sortPicks,
  type ListingPickRow,
} from "../src/listing-grouping.ts";
import type { Windowed } from "../src/scoring.ts";

function row(over: Partial<ListingPickRow> = {}): ListingPickRow {
  return {
    source: "suumo:ms-chuko",
    external_id: "id1",
    ward_code: "40132",
    district_name: "博多区",
    building_name: "アンピール空港南",
    building_year: 2005,
    built_month: 4,
    area_sqm: 72.5,
    floor_plan: "3LDK",
    line_name: "地下鉄空港線",
    station_name: "博多",
    walk_minutes: 8,
    bus: 0,
    address: "福岡県福岡市博多区東平尾",
    url: "https://suumo.jp/ms/chuko/fukuoka/sc_hakata/nc_1",
    first_seen: "2026-09-10",
    last_seen: "2026-09-14",
    current_price: 42000000,
    first_price: 42800000,
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

test("既定条件: 4800万以下・70㎡以上・3LDK以上・築25年以内・徒歩10分以内（バス便は除外）", () => {
  const f = parsePickFilters(new URLSearchParams(), () => true);
  assert.deepEqual(f, { ...DEFAULT_PICK_FILTERS });
  assert.equal(f.priceMaxMan, 4800);
  assert.equal(f.areaMin, 70);
  const nowYear = 2026;
  const today = "2026-09-14";
  assert.equal(matchesConditions(row(), f, nowYear, today), true);
  assert.equal(matchesConditions(row({ current_price: 48000001 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ area_sqm: 69.9 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ floor_plan: "2LDK" }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ floor_plan: "3DK" }), f, nowYear, today), false, "3DKは既定でno");
  assert.equal(matchesConditions(row({ building_year: 2000 }), f, nowYear, today), false, "築26年は既定でno（25年超）");
  assert.equal(matchesConditions(row({ building_year: 2001 }), f, nowYear, today), true, "築25年はyes");
  assert.equal(matchesConditions(row({ walk_minutes: 11 }), f, nowYear, today), false);
  assert.equal(matchesConditions(row({ bus: 1, walk_minutes: null }), f, nowYear, today), false, "バス便は既定で除外");
});

test("既定条件の境界: 4,800万ちょうど・70㎡ちょうどは含む", () => {
  const f = parsePickFilters(new URLSearchParams(), () => true);
  const today = "2026-09-14";
  assert.equal(matchesConditions(row({ current_price: 48000000 }), f, 2026, today), true, "4,800万ちょうどはyes");
  assert.equal(matchesConditions(row({ area_sqm: 70 }), f, 2026, today), true, "70㎡ちょうどはyes");
  assert.equal(matchesConditions(row({ current_price: 48000000, area_sqm: 70 }), f, 2026, today), true);
  // 旧既定（3,600万・65㎡）の外側でも、新既定の内側なら拾う
  assert.equal(matchesConditions(row({ current_price: 45000000, area_sqm: 75 }), f, 2026, today), true);
  assert.equal(matchesConditions(row({ area_sqm: 67 }), f, 2026, today), false, "65〜70㎡未満は新既定でno");
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

test("住所 → 町名: 県名・市名の有無、全角/半角数字、丁目の有無を吸収する", () => {
  for (const a of [
    "福岡県福岡市東区千早４",
    "福岡県福岡市東区千早4",
    "福岡市東区千早４丁目",
    "東区千早4丁目",
    "東区千早四丁目",
    "福岡県福岡市東区千早４－１－２",
    "福岡県福岡市東区千早4-1-2",
    "福岡県 福岡市東区 千早",
    "福岡県福岡市東区千早",
  ]) {
    assert.equal(districtNameFromAddress(a), "千早", a);
  }
  assert.equal(districtNameFromAddress("福岡県福岡市早良区藤崎１"), "藤崎");
  assert.equal(districtNameFromAddress("福岡県福岡市中央区輝国２"), "輝国");
});

test("住所 → 町名: 近郊・郡・旧字・大字", () => {
  assert.equal(districtNameFromAddress("福岡県筑紫野市二日市南１"), "二日市南", "町名の漢数字は切らない");
  assert.equal(districtNameFromAddress("福岡県春日市春日原北町２"), "春日原北町");
  assert.equal(districtNameFromAddress("福岡県糟屋郡須惠町大字旅石"), "旅石", "旧字の郡・町と大字");
  assert.equal(districtNameFromAddress("福岡県糟屋郡粕屋町仲原２丁目"), "仲原");
  assert.equal(districtNameFromAddress("福岡県糟屋郡志免町南里３"), "南里");
  assert.equal(districtNameFromAddress("福岡県福岡市博多区五十川１"), "五十川");
  assert.equal(districtNameFromAddress("福岡県福岡市東区三苫６"), "三苫");
});

test("住所 → 町名: 台帳に無い市町（〇〇市△△町）・読めないもの", () => {
  assert.equal(districtNameFromAddress("福岡県久留米市城南町１"), "城南町");
  assert.equal(districtNameFromAddress("福岡県北九州市小倉北区魚町２"), "魚町");
  assert.equal(districtNameFromAddress("福岡県遠賀郡水巻町頃末北１"), "頃末北");
  assert.equal(districtNameFromAddress(null), null);
  assert.equal(districtNameFromAddress(""), null);
  assert.equal(districtNameFromAddress("福岡県福岡市東区"), null, "町名が無い");
});

function win(nRecent: number, medRecent: number | null, nPrior: number, medPrior: number | null): Windowed {
  return { nRecent, medRecent, nPrior, medPrior };
}

test("価格維持: 地区が最低件数を満たせば地区、足りなければ市区町村、どちらも無ければ null", () => {
  const districtWindows = new Map<string, Windowed>([
    ["40131\t千早", win(12, 440000, 9, 400000)],
    ["40131\t香椎", win(7, 300000, 9, 280000)], // 直近 8 件未満 → 地区は使わない
    ["40344\t大字旅石", win(8, 210000, 5, 200000)], // 「大字」付きでも住所の「旅石」に当たる
  ]);
  const wardWindows = new Map<string, Windowed>([
    ["40131", win(300, 380000, 250, 350000)],
    ["40344", win(5, 200000, 4, 190000)], // 市区町村の最低件数（20/10）未満
  ]);
  const idx = indexDistrictWindows(districtWindows);
  const name = (c: string) => ({ "40131": "東区", "40344": "須恵町" })[c] ?? null;

  const d = pickRetention("40131", districtNameFromAddress("福岡県福岡市東区千早４"), idx, wardWindows, name);
  assert.equal(d?.level, "district");
  assert.equal(d?.areaName, "千早");
  assert.equal(d?.nRecent, 12);
  assert.ok(Math.abs((d?.value ?? 0) - 1.1) < 1e-9);

  const m = pickRetention("40131", "香椎", idx, wardWindows, name);
  assert.equal(m?.level, "municipality", "地区の件数不足 → 市区町村へ落とす");
  assert.equal(m?.areaName, "東区");
  assert.ok(Math.abs((m?.value ?? 0) - 380000 / 350000) < 1e-9);

  const unknown = pickRetention("40131", null, idx, wardWindows, name);
  assert.equal(unknown?.level, "municipality", "町名が読めなくても市区町村の値は出す");

  const oaza = pickRetention("40344", districtNameFromAddress("福岡県糟屋郡須惠町大字旅石"), idx, wardWindows, name);
  assert.equal(oaza?.level, "district");
  assert.equal(oaza?.areaName, "大字旅石");

  assert.equal(pickRetention("40344", "上須恵", idx, wardWindows, name), null, "地区も市区町村も件数不足");

  const kasuga = indexDistrictWindows(new Map([["40218\t白水ケ丘", win(9, 300000, 6, 290000)]]));
  const ke = pickRetention("40218", districtNameFromAddress("福岡県春日市白水ヶ丘１"), kasuga, new Map(), name);
  assert.equal(ke?.level, "district", "「ヶ」と「ケ」の表記ゆれ");
  assert.equal(pickRetention(null, "千早", idx, wardWindows, name), null);
});

test("並べ替え: sort=retention は価格維持の高い順・値なしは末尾（その中は新着順）、既定は新着順", () => {
  assert.equal(parsePickSort(new URLSearchParams("")), "newest");
  assert.equal(parsePickSort(new URLSearchParams("sort=retention")), "retention");
  assert.equal(parsePickSort(new URLSearchParams("sort=bogus")), "newest");

  const cards = [
    { id: "none-old", latestFirstSeen: "2026-09-01", minPrice: 40000000, retention: null },
    { id: "low", latestFirstSeen: "2026-09-12", minPrice: 40000000, retention: { value: 0.98 } },
    { id: "high", latestFirstSeen: "2026-09-02", minPrice: 45000000, retention: { value: 1.12 } },
    { id: "none-new", latestFirstSeen: "2026-09-13", minPrice: 41000000, retention: null },
    { id: "mid-new", latestFirstSeen: "2026-09-10", minPrice: 44000000, retention: { value: 1.05 } },
    { id: "mid-old", latestFirstSeen: "2026-09-05", minPrice: 39000000, retention: { value: 1.05 } },
  ];
  assert.deepEqual(
    sortGroupsByRetention(cards).map((c) => c.id),
    ["high", "mid-new", "mid-old", "low", "none-new", "none-old"],
  );
  assert.deepEqual(sortPicks(cards, "retention").map((c) => c.id), sortGroupsByRetention(cards).map((c) => c.id));
  assert.deepEqual(
    sortPicks(cards, "newest").map((c) => c.id),
    ["none-new", "low", "mid-new", "mid-old", "high", "none-old"],
  );
  assert.equal(cards[0]!.id, "none-old", "元の配列は並べ替えない");
});

test("汎用ソート: ListingGroup もカードも同じ関数で並べられる", () => {
  const groups = groupListings([
    row({ external_id: "a", building_name: "ビルA", first_seen: "2026-09-01" }),
    row({ external_id: "b", building_name: "ビルB", first_seen: "2026-09-12" }),
  ]);
  // ListingGroup には retention が無い → 全部「値なし」扱いで新着順
  assert.deepEqual(sortGroupsByRetention(groups).map((g) => g.buildingName), ["ビルB", "ビルA"]);
  assert.deepEqual(sortGroupsNewestFirst(groups).map((g) => g.buildingName), ["ビルB", "ビルA"]);
});

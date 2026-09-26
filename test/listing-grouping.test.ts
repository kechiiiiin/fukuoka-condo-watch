// 「条件に合う新着・掲載中の物件」ビュー（src/listing-picks.ts）のうち D1 に触らない純粋関数のテスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PICK_FILTERS,
  DEFAULT_RENT_PICK_FILTERS,
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

// ---------------------------------------------------------------- 賃貸（kind=rent・2026-09-26）

function rentRow(over: Partial<ListingPickRow> = {}): ListingPickRow {
  return row({
    source: "suumo:chintai",
    external_id: "jnc_000012345678",
    current_price: 125000,
    first_price: 125000,
    price_cut_count: 0,
    url: "https://suumo.jp/chintai/jnc_000012345678/",
    admin_fee: 5000,
    deposit: 125000,
    key_money: 0,
    pets_allowed: 0,
    listed_on: "2026-09-20",
    ...over,
  });
}

test("賃貸の既定条件: 家賃15万円以下・70㎡以上・3LDK以上・築25年以内・ペット可のみ（徒歩は指定なし・バス便も含む）", () => {
  const today = "2026-09-26";
  const f = parsePickFilters(new URLSearchParams(""), () => true, "rent");
  assert.deepEqual(f, { ...DEFAULT_RENT_PICK_FILTERS });
  assert.equal(f.priceMaxMan, 15);
  assert.equal(f.walkMax, null);
  assert.equal(f.includeBus, true);
  assert.equal(f.petsOnly, true, "ペット可は必須（2026-09-26 の線引き）");

  assert.equal(matchesConditions(rentRow({ pets_allowed: 1 }), f, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ pets_allowed: null }), f, 2026, today), false, "ペットの印が無いものは既定では出さない");

  // 家賃・面積・間取り・築年の枠（ペット以外）は pets=0 で外して確かめる
  const g = parsePickFilters(new URLSearchParams("pets=0"), () => true, "rent");
  assert.equal(matchesConditions(rentRow(), g, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ current_price: 150000 }), g, 2026, today), true, "15万円ちょうどはyes");
  assert.equal(matchesConditions(rentRow({ current_price: 150001 }), g, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ area_sqm: 69.9 }), g, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ floor_plan: "2LDK" }), g, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ floor_plan: "3DK" }), g, 2026, today), false, "3DKは既定でno（dk=1 で含む）");
  assert.equal(matchesConditions(rentRow({ building_year: 2000 }), g, 2026, today), false, "築26年はno");
  // 徒歩の指定が無いので、駅が遠い・駅情報が無い・バス便でも落とさない
  assert.equal(matchesConditions(rentRow({ walk_minutes: 25 }), g, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ walk_minutes: null }), g, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ bus: 1, walk_minutes: null }), g, 2026, today), true);
  // 売買の既定は変わっていない（回帰）
  assert.equal(DEFAULT_PICK_FILTERS.priceMaxMan, 4800);
  assert.equal(DEFAULT_PICK_FILTERS.walkMax, 10);
  assert.equal(DEFAULT_PICK_FILTERS.includeBus, false);
  assert.equal(DEFAULT_PICK_FILTERS.petsOnly, false);
});

test("ペット相談可トグル: 賃貸は既定 ON・pets=0 で外せる（sale では常に無効）", () => {
  const today = "2026-09-26";
  // 2026-09-26 に「良い物件の線引き＝①ペット可であること ②博多駅までの距離」と決まったので既定 ON
  const off = parsePickFilters(new URLSearchParams("pets=0"), () => true, "rent");
  assert.equal(off.petsOnly, false);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 0 }), off, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1 }), off, 2026, today), true);

  const on = parsePickFilters(new URLSearchParams(""), () => true, "rent");
  assert.equal(on.petsOnly, true, "引数なしの既定でペット可だけ");
  assert.equal(parsePickFilters(new URLSearchParams("pets=1"), () => true, "rent").petsOnly, true);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1 }), on, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 0 }), on, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ pets_allowed: null }), on, 2026, today), false, "不明（NULL）は絞り込みで残さない。NULL はペット不可の意味ではない");

  // 売買では pets を送っても効かない（sale の行に pets_allowed は無い）
  assert.equal(parsePickFilters(new URLSearchParams("pets=1"), () => true, "sale").petsOnly, false);
  assert.equal(parsePickFilters(new URLSearchParams("pets=1"), () => true).petsOnly, false, "kind 省略は従来どおり売買");
});

/**
 * 2026-09-26 に足した「理想条件」。
 * ⚠️ **建物の階数では絞らない**（本人に確認して「2 階建ての建物は嫌ではない」となった）。
 *    既定は buildingFloorsMin = null で、URL の floors= を付けたときだけ効く任意の絞り込み。
 */
test("賃貸の既定: メゾネットを除く・LDK 15畳以上。建物の階数では絞らない", () => {
  const today = "2026-09-26";
  const f = parsePickFilters(new URLSearchParams(""), () => true, "rent");
  assert.equal(f.excludeMaisonette, true);
  assert.equal(f.ldkTatamiMin, 15);
  assert.equal(f.buildingFloorsMin, null, "建物の階数は既定では絞らない");

  const base = { pets_allowed: 1 } as const;
  // メゾネット: 1 は落とす・**NULL（不明）は落とさない**
  assert.equal(matchesConditions(rentRow({ ...base, maisonette: null, ldk_tatami: 16 }), f, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ ...base, maisonette: 1, ldk_tatami: 16 }), f, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ ...base, ldk_tatami: 16 }), f, 2026, today), true, "列が無い行も落とさない");

  // LDK の畳数: 15 未満は落とす・ちょうど 15 は残す・**NULL（未取得）は落とさない**
  assert.equal(matchesConditions(rentRow({ ...base, ldk_tatami: 15 }), f, 2026, today), true, "15畳ちょうどはyes");
  assert.equal(matchesConditions(rentRow({ ...base, ldk_tatami: 14.9 }), f, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ ...base, ldk_tatami: null }), f, 2026, today), true, "未取得は落とさない（15畳未満の意味ではない）");

  // 建物の階数: 2 階建てでも既定では残る
  assert.equal(matchesConditions(rentRow({ ...base, building_floors: 2, ldk_tatami: 16 }), f, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ ...base, building_floors: null, ldk_tatami: 16 }), f, 2026, today), true);
});

test("賃貸: 既定の絞り込みは URL で外せる（mais=0 / tatami=0 / floors=N）", () => {
  const today = "2026-09-26";
  const noMais = parsePickFilters(new URLSearchParams("mais=0"), () => true, "rent");
  assert.equal(noMais.excludeMaisonette, false);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1, maisonette: 1, ldk_tatami: 16 }), noMais, 2026, today), true);

  const noTatami = parsePickFilters(new URLSearchParams("tatami=0"), () => true, "rent");
  assert.equal(noTatami.ldkTatamiMin, null, "0 以下は「絞らない」の意味");
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1, ldk_tatami: 8 }), noTatami, 2026, today), true);
  assert.equal(parsePickFilters(new URLSearchParams("tatami=18"), () => true, "rent").ldkTatamiMin, 18);

  // 建物の階数は「既定は無効・指定したときだけ効く」。⚠️ 不明（NULL）は落とさない
  const floors3 = parsePickFilters(new URLSearchParams("floors=3"), () => true, "rent");
  assert.equal(floors3.buildingFloorsMin, 3);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1, ldk_tatami: 16, building_floors: 3 }), floors3, 2026, today), true);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1, ldk_tatami: 16, building_floors: 2 }), floors3, 2026, today), false);
  assert.equal(matchesConditions(rentRow({ pets_allowed: 1, ldk_tatami: 16, building_floors: null }), floors3, 2026, today), true, "階数不明は落とさない");

  // 売買では賃貸だけの条件は効かない
  const sale = parsePickFilters(new URLSearchParams("mais=1&tatami=20&floors=5"), () => true, "sale");
  assert.deepEqual(
    { m: sale.excludeMaisonette, t: sale.ldkTatamiMin, f: sale.buildingFloorsMin },
    { m: false, t: null, f: null },
  );
});

test("賃貸のグルーピング: 階数・メゾネット・LDK 畳数をまとめる", () => {
  const g = groupListings([
    rentRow({ external_id: "jnc_1", building_floors: 8, room_floor: 4, maisonette: null, ldk_tatami: 16.4, detail_fetched_at: "2026-09-26T00:00:00Z" }),
    rentRow({ external_id: "jnc_2", current_price: 128000, building_floors: 8, room_floor: 6, maisonette: null, ldk_tatami: 18, detail_fetched_at: null }),
  ])[0]!;
  assert.equal(g.buildingFloors, 8);
  assert.equal(g.roomFloorMin, 4);
  assert.equal(g.roomFloorMax, 6, "同条件の部屋が複数なら幅で出す");
  assert.equal(g.maisonette, false, "印が無ければ false（＝不明。ワンフロアだと確かめた意味ではない）");
  assert.equal(g.ldkTatami, 16.4, "畳数は一番小さいもの（控えめに出す）");
  assert.equal(g.detailFetched, true, "1 件でも詳細を取っていれば true");

  const mais = groupListings([rentRow({ maisonette: 1 })])[0]!;
  assert.equal(mais.maisonette, true);
  // 売買のグループでは 0007 の項目も空（回帰）
  const sale = groupListings([row()])[0]!;
  assert.deepEqual(
    { b: sale.buildingFloors, r: sale.roomFloorMin, m: sale.maisonette, t: sale.ldkTatami, d: sale.detailFetched },
    { b: null, r: null, m: false, t: null, d: false },
  );
});

// ⚠️ listed_on は SUUMO 賃貸では常に NULL（一覧に掲載日が無い）。ここで値を入れているのは
//    listings の汎用の列としてのまとめ方（最新を採る）を確かめるため
test("賃貸のグルーピング: 敷礼・管理費・ペット・掲載日をまとめる", () => {
  const groups = groupListings([
    rentRow({ external_id: "jnc_1", current_price: 125000, admin_fee: 5000, deposit: 125000, key_money: 0, pets_allowed: 0, listed_on: "2026-09-20" }),
    rentRow({ external_id: "jnc_2", current_price: 128000, admin_fee: 8000, deposit: 0, key_money: 128000, pets_allowed: 1, listed_on: "2026-09-22" }),
  ]);
  assert.equal(groups.length, 1, "同じ建物・間取り・築年・面積は 1 枚のカードにまとめる（売買と同じロジック）");
  const g = groups[0]!;
  assert.equal(g.count, 2);
  assert.equal(g.minPrice, 125000);
  assert.equal(g.maxPrice, 128000);
  assert.equal(g.adminFeeMin, 5000);
  assert.equal(g.adminFeeMax, 8000);
  assert.equal(g.depositMin, 0);
  assert.equal(g.keyMoneyMin, 0);
  assert.equal(g.petsAllowed, true, "1 件でも相談可ならカードに出す");
  assert.equal(g.latestListedOn, "2026-09-22");
  // 売買のグループでは賃貸の項目は空（回帰）
  const sale = groupListings([row()])[0]!;
  assert.equal(sale.adminFeeMin, null);
  assert.equal(sale.petsAllowed, false);
  assert.equal(sale.latestListedOn, null);
});

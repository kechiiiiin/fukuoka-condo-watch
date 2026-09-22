// 新築ビュー（/listings/shinchiku・/api/listings/shinchiku）のうち D1 に触らない純粋関数。test/new-listing-view.test.ts から直接テストする。
//
// 新築プレミアム = 新築の㎡単価 ÷ 同じ地区（町名）または市区町村の「築10年以内の中古」の成約㎡単価の中央値（直近2年）− 1
//   - 新築の㎡単価: ㎡単価の幅の中央（下限と上限の平均）。上限が無ければ下限。価格未定なら出さない
//   - 分母: 国交省 XIT001 の成約価格（DEFAULT_CAT）・直近 8 四半期・取引年 − 建築年 が 0〜10 年の取引の ㎡単価中央値
//   - 地区（住所から起こした町名・districtNameFromAddress）が MIN_DISTRICT_RECENT_SALES 件以上あれば地区、
//     無ければ市区町村（MIN_RECENT_SALES 件以上）。どちらも足りなければ出さない（null）

import { districtNameFromAddress, normalizeDistrictKey, parseMunicipalities } from "./listing-grouping";
import { median } from "./listing-scoring";
import { MIN_DISTRICT_RECENT_SALES, MIN_RECENT_SALES } from "./scoring";

/** new_listings の 1 行（表示に使う列） */
export interface NewListingRow {
  external_id: string;
  listing_type: string;
  ward_code: string | null;
  building_name: string | null;
  address: string | null;
  line_name: string | null;
  station_name: string | null;
  walk_minutes: number | null;
  bus: number;
  price_min: number | null;
  price_max: number | null;
  price_undecided: number;
  price_tentative: number;
  area_min: number | null;
  area_max: number | null;
  unit_price_min: number | null;
  unit_price_max: number | null;
  floor_plans: string | null;
  sale_status: string | null;
  sale_label: string | null;
  delivery_text: string | null;
  delivery_ym: string | null;
  delivery_immediate: number;
  url: string | null;
  first_seen: string;
  last_seen: string;
  first_price_min: number | null;
  first_price_max: number | null;
  price_change_count: number;
  delisted_on: string | null;
}

export type NewSort = "newest" | "premium" | "price" | "delivery";
export type NewTypeFilter = "all" | "project" | "unit";

export interface NewFilters {
  /** true = 価格・面積の条件をかけない（全件） */
  all: boolean;
  /** 価格の下限がこれ以下（万円） */
  priceMaxMan: number;
  /** 面積の上限がこれ以上（㎡） */
  areaMin: number;
  /** 価格未定（下限が無い）も出す */
  includeUndecided: boolean;
  type: NewTypeFilter;
  municipalities: string[] | null;
  /** 掲載終了（完売・掲載終了）も出す */
  includeEnded: boolean;
  sort: NewSort;
}

/** 既定は家族の希望条件（/listings/picks と同じ 4,800万・70㎡）を新築の幅に当てたもの */
export const DEFAULT_NEW_FILTERS = { priceMaxMan: 4800, areaMin: 70 } as const;

function num(v: string | null, min: number, max: number): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function parseNewFilters(params: URLSearchParams, isAreaCode: (v: string) => boolean): NewFilters {
  const sortRaw = params.get("sort");
  const typeRaw = params.get("type");
  return {
    all: params.get("all") === "1",
    priceMaxMan: num(params.get("pmax"), 0, 1_000_000) ?? DEFAULT_NEW_FILTERS.priceMaxMan,
    areaMin: num(params.get("amin"), 0, 1000) ?? DEFAULT_NEW_FILTERS.areaMin,
    includeUndecided: params.get("undecided") !== "0",
    type: typeRaw === "project" || typeRaw === "unit" ? typeRaw : "all",
    municipalities: parseMunicipalities(params, isAreaCode),
    includeEnded: params.get("ended") === "1",
    sort: sortRaw === "premium" || sortRaw === "price" || sortRaw === "delivery" ? sortRaw : "newest",
  };
}

export function matchesNewFilters(r: NewListingRow, f: NewFilters): boolean {
  if (!f.includeEnded && r.delisted_on !== null) return false;
  if (f.type !== "all" && r.listing_type !== f.type) return false;
  if (f.municipalities && (!r.ward_code || !f.municipalities.includes(r.ward_code))) return false;
  if (f.all) return true;
  if (r.price_min === null) {
    if (!f.includeUndecided) return false;
  } else if (r.price_min > f.priceMaxMan * 10000) {
    return false;
  }
  // 面積の上限が分からないものは落とさない（一覧に面積の無い掲載はまれ）
  if (r.area_max !== null && r.area_max < f.areaMin) return false;
  return true;
}

/** プレミアムに使う新築の㎡単価（円/㎡）: 幅の中央、上限が無ければ下限。価格未定なら null */
export function newUnitPriceForPremium(r: Pick<NewListingRow, "unit_price_min" | "unit_price_max">): number | null {
  if (r.unit_price_min === null) return null;
  if (r.unit_price_max === null) return r.unit_price_min;
  return (r.unit_price_min + r.unit_price_max) / 2;
}

export interface UsedBaseline {
  /** 市区町村コード → 築10年以内の成約㎡単価の中央値と件数 */
  municipalities: Map<string, { median: number; n: number }>;
  /** `${市区町村コード}\t${normalizeDistrictKey(地区名)}` → 同上（name は XIT001 の地区名） */
  districts: Map<string, { name: string; median: number; n: number }>;
}

/** 築10年以内の中古の成約（直近2年ぶん）から、市区町村・地区ごとの㎡単価中央値を作る */
export function buildUsedBaseline(rows: { ward_code: string; district_name: string | null; unit_price: number }[]): UsedBaseline {
  const byMuni = new Map<string, number[]>();
  const byDistrict = new Map<string, { names: Map<string, number>; v: number[] }>();
  for (const r of rows) {
    if (!(r.unit_price > 0)) continue;
    (byMuni.get(r.ward_code) ?? byMuni.set(r.ward_code, []).get(r.ward_code)!).push(r.unit_price);
    const norm = normalizeDistrictKey(r.district_name);
    if (!norm || !r.district_name) continue;
    const k = `${r.ward_code}\t${norm}`;
    const d = byDistrict.get(k) ?? byDistrict.set(k, { names: new Map(), v: [] }).get(k)!;
    d.v.push(r.unit_price);
    d.names.set(r.district_name, (d.names.get(r.district_name) ?? 0) + 1);
  }
  const municipalities = new Map<string, { median: number; n: number }>();
  for (const [k, v] of byMuni) municipalities.set(k, { median: median(v)!, n: v.length });
  const districts = new Map<string, { name: string; median: number; n: number }>();
  for (const [k, d] of byDistrict) {
    // 表記ゆれ（「大字◯◯」「◯◯」）は件数の多い方の名前で見せる
    const name = [...d.names.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    districts.set(k, { name, median: median(d.v)!, n: d.v.length });
  }
  return { municipalities, districts };
}

export interface NewPremium {
  /** 新築㎡単価 ÷ 築10年以内中古の成約㎡単価中央値 − 1（0.25 = 25% 高い） */
  value: number;
  level: "district" | "municipality";
  areaName: string;
  /** 分母の件数 */
  n: number;
  /** 分母（円/㎡） */
  usedUnitMedian: number;
  /** 分子（円/㎡） */
  newUnit: number;
}

export function premiumFor(
  newUnit: number | null,
  wardCode: string | null,
  address: string | null,
  baseline: UsedBaseline,
  municipalityName: (code: string) => string | null,
): NewPremium | null {
  if (newUnit === null || !wardCode) return null;
  const norm = normalizeDistrictKey(districtNameFromAddress(address));
  const d = norm ? baseline.districts.get(`${wardCode}\t${norm}`) : undefined;
  const pick =
    d && d.n >= MIN_DISTRICT_RECENT_SALES
      ? { level: "district" as const, areaName: d.name, median: d.median, n: d.n }
      : (() => {
          const m = baseline.municipalities.get(wardCode);
          return m && m.n >= MIN_RECENT_SALES
            ? { level: "municipality" as const, areaName: municipalityName(wardCode) ?? wardCode, median: m.median, n: m.n }
            : null;
        })();
  if (!pick || !(pick.median > 0)) return null;
  return {
    value: Math.round((newUnit / pick.median - 1) * 1000) / 1000,
    level: pick.level,
    areaName: pick.areaName,
    n: pick.n,
    usedUnitMedian: Math.round(pick.median),
    newUnit: Math.round(newUnit),
  };
}

export interface SortableNew {
  firstSeen: string;
  priceMin: number | null;
  deliveryYm: string | null;
  deliveryImmediate: boolean;
  premium: NewPremium | null;
  buildingName: string | null;
}

/** 並べ替え。値の無いもの（価格未定・プレミアムなし・引渡時期不明）は末尾 */
export function sortNew<T extends SortableNew>(items: readonly T[], sort: NewSort): T[] {
  const name = (a: T, b: T) => (a.buildingName ?? "").localeCompare(b.buildingName ?? "", "ja");
  const nullsLast = (x: number | null, y: number | null) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : x - y);
  const out = [...items];
  switch (sort) {
    case "premium":
      return out.sort((a, b) => nullsLast(a.premium?.value ?? null, b.premium?.value ?? null) || name(a, b));
    case "price":
      return out.sort((a, b) => nullsLast(a.priceMin, b.priceMin) || name(a, b));
    case "delivery": {
      const key = (x: T) => (x.deliveryImmediate ? 0 : x.deliveryYm ? Number(x.deliveryYm.replace("-", "")) : null);
      return out.sort((a, b) => nullsLast(key(a), key(b)) || name(a, b));
    }
    default:
      return out.sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0) || name(a, b));
  }
}

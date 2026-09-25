// 「条件に合う新着・掲載中の物件」ビュー（/listings/picks・/api/listings/picks）のうち、
// D1 に触らない純粋関数。src/listing-picks.ts から使う。test/listing-grouping.test.ts で直接テストする
// （tsconfig.test.json の include に入れている）。
//
// 同じ部屋が複数の仲介業者から別の external_id で重複掲載されるため（例: アンピール空港南が 11 件）、
// 建物名（正規化）＋専有面積（±0.5㎡）＋間取り＋築年でグルーピングして 1 枚のカードにまとめる。

import { districtHasEnoughSales, municipalityHasEnoughSales, retentionOf, type Windowed } from "./scoring";
import { AREAS } from "./wards";

export interface ListingPickRow {
  source: string;
  external_id: string;
  ward_code: string | null;
  district_name: string | null;
  building_name: string | null;
  building_year: number | null;
  built_month: number | null;
  area_sqm: number | null;
  floor_plan: string | null;
  line_name: string | null;
  station_name: string | null;
  walk_minutes: number | null;
  /** 1 = 駅までバス便（walk_minutes は NULL） */
  bus: number;
  address: string | null;
  url: string | null;
  first_seen: string;
  last_seen: string;
  current_price: number;
  first_price: number | null;
  price_cut_count: number;
  relisted_count: number;
  // ---- 賃貸（kind = 'rent'）だけ。売買の行では NULL / 0（0006 で足した列） ----
  admin_fee?: number | null;
  deposit?: number | null;
  key_money?: number | null;
  /** 1 = ペット相談可 */
  pets_allowed?: number | null;
  listed_on?: string | null;
}

/**
 * 建物名の正規化（グルーピングの突き合わせキー用。表示には使わない）。
 * NFKC で全角/半角を揃え、空白・よくある記号（中黒・長音・ハイフン類・括弧・句読点）を落とす。
 * 「棟」「号棟」はそのまま残す（別棟は別物件のため、安易に潰さない）。
 */
export function normalizeBuildingName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/[･・ｰー\-‐-‒–—―.,、。()（）[\]【】]/g, "")
    .toUpperCase();
}

export interface FloorPlanInfo {
  /** 先頭の部屋数（"3LDK" → 3）。読めなければ null */
  rooms: number | null;
  /** LDK タイプか（L を含む）。含まないと DK・K タイプ */
  hasL: boolean;
}

export function parseFloorPlan(floorPlan: string | null | undefined): FloorPlanInfo {
  const s = (floorPlan ?? "").normalize("NFKC").toUpperCase();
  const m = /^(\d+)/.exec(s);
  return { rooms: m ? Number(m[1]) : null, hasL: /L/.test(s) };
}

export interface PickFilters {
  /** 価格の上限（万円） */
  priceMaxMan: number;
  /** 専有面積の下限（㎡） */
  areaMin: number;
  /** 間取りの部屋数の下限（3LDK なら 3） */
  planRoomsMin: number;
  /** true なら DK・K タイプ（L を含まない間取り）も許す。既定は LDK タイプのみ */
  includeDK: boolean;
  /** 築年数の上限（年）。building_year >= 今年 - ageMax */
  ageMax: number;
  /** 駅からの徒歩分の上限。null = 指定なし（駅情報が無い物件も落とさない） */
  walkMax: number | null;
  /** true ならバス便の物件も許す。既定は除外（賃貸は既定で含める） */
  includeBus: boolean;
  /** true ならペット相談可の物件だけ（賃貸のみ。既定 false = 絞らない） */
  petsOnly: boolean;
  /** 対象の市区町村コード（null = すべて） */
  municipalities: string[] | null;
  /** true なら新着（first_seen が直近 freshDays 日以内）だけ */
  freshOnly: boolean;
  /** 「新着」とみなす日数 */
  freshDays: number;
}

/** 画面の種類。sale = 中古の売り物件（既定）/ rent = 賃貸 */
export type PickKind = "sale" | "rent";

export function parsePickKind(v: string | null | undefined): PickKind {
  return v === "rent" ? "rent" : "sale";
}

/** 売買（中古）の既定条件 */
export const DEFAULT_PICK_FILTERS: Omit<PickFilters, "municipalities"> & { municipalities: null } = {
  priceMaxMan: 4800,
  areaMin: 70,
  planRoomsMin: 3,
  includeDK: false,
  ageMax: 25,
  walkMax: 10,
  includeBus: false,
  petsOnly: false,
  municipalities: null,
  freshOnly: false,
  freshDays: 7,
};

/**
 * 賃貸の既定条件（2026-09-26 の依頼）: 家賃 15 万円以下・70㎡以上・3LDK 以上・築 25 年以内。
 * 徒歩分は指定なし（依頼に無い条件で勝手に狭めない）・バス便も含める。ペット相談可は絞らない（トグルで絞る）。
 */
export const DEFAULT_RENT_PICK_FILTERS: Omit<PickFilters, "municipalities"> & { municipalities: null } = {
  priceMaxMan: 15,
  areaMin: 70,
  planRoomsMin: 3,
  includeDK: false,
  ageMax: 25,
  walkMax: null,
  includeBus: true,
  petsOnly: false,
  municipalities: null,
  freshOnly: false,
  freshDays: 7,
};

export function defaultPickFilters(kind: PickKind) {
  return kind === "rent" ? DEFAULT_RENT_PICK_FILTERS : DEFAULT_PICK_FILTERS;
}

/** 数値クエリパラメータを読む。空・不正なら null */
function num(params: URLSearchParams, key: string): number | null {
  const v = params.get(key);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(params: URLSearchParams, key: string, dflt: boolean): boolean {
  const v = params.get(key);
  if (v === null) return dflt;
  return v === "1" || v === "true";
}

/** 有効な市区町村コード（AREA_NAME にある）だけを残す。全部無効なら null（=すべて） */
export function parseMunicipalities(params: URLSearchParams, isAreaCode: (v: string) => boolean): string[] | null {
  const v = params.get("muni");
  if (v === null || v.trim() === "") return null;
  const codes = v
    .split(",")
    .map((x) => x.trim())
    .filter((x) => isAreaCode(x));
  return codes.length > 0 ? codes : null;
}

/** kind を省略すると売買（従来どおり）。賃貸は既定条件が違う（DEFAULT_RENT_PICK_FILTERS） */
export function parsePickFilters(params: URLSearchParams, isAreaCode: (v: string) => boolean, kind: PickKind = "sale"): PickFilters {
  const d = defaultPickFilters(kind);
  return {
    priceMaxMan: num(params, "pmax") ?? d.priceMaxMan,
    areaMin: num(params, "amin") ?? d.areaMin,
    planRoomsMin: num(params, "plan") ?? d.planRoomsMin,
    includeDK: bool(params, "dk", d.includeDK),
    ageMax: num(params, "age") ?? d.ageMax,
    walkMax: num(params, "walk") ?? d.walkMax,
    includeBus: bool(params, "bus", d.includeBus),
    petsOnly: kind === "rent" ? bool(params, "pets", d.petsOnly) : false,
    municipalities: parseMunicipalities(params, isAreaCode),
    freshOnly: bool(params, "fresh", d.freshOnly),
    freshDays: d.freshDays,
  };
}

/** 並べ替え。newest = 新着順（既定）/ retention = 価格維持の高い順 */
export type PickSort = "newest" | "retention";

export function parsePickSort(params: URLSearchParams): PickSort {
  return params.get("sort") === "retention" ? "retention" : "newest";
}

/** 行が条件に合うか（掲載中かどうかはここでは見ない。呼び出し側で delisted_on IS NULL を絞ってから使う） */
export function matchesConditions(row: ListingPickRow, f: PickFilters, nowYear: number, today: string): boolean {
  if (row.current_price > f.priceMaxMan * 10000) return false;
  if (row.area_sqm === null || row.area_sqm < f.areaMin) return false;

  const plan = parseFloorPlan(row.floor_plan);
  if (plan.rooms === null || plan.rooms < f.planRoomsMin) return false;
  if (!plan.hasL && !f.includeDK) return false;

  if (row.building_year === null || row.building_year < nowYear - f.ageMax) return false;

  if (row.bus) {
    if (!f.includeBus) return false;
  } else if (f.walkMax !== null && (row.walk_minutes === null || row.walk_minutes > f.walkMax)) {
    return false;
  }

  // ペット相談可（賃貸のみ。sale の行は pets_allowed が 0 / undefined なので、トグル ON なら残らない）
  if (f.petsOnly && !row.pets_allowed) return false;

  if (f.municipalities && (!row.ward_code || !f.municipalities.includes(row.ward_code))) return false;

  if (f.freshOnly) {
    const since = addDaysStr(today, -f.freshDays);
    if (row.first_seen < since) return false;
  }

  return true;
}

const dayMs = 86_400_000;
function addDaysStr(d: string, n: number): string {
  const dayNum = Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
  return new Date((dayNum + n) * dayMs).toISOString().slice(0, 10);
}

export interface ListingGroup {
  /** グルーピングのキー（デバッグ・テスト用。表示しない） */
  key: string;
  buildingName: string;
  wardCode: string | null;
  districtName: string | null;
  address: string | null;
  areaSqm: number | null;
  floorPlan: string | null;
  buildingYear: number | null;
  builtMonth: number | null;
  lineName: string | null;
  stationName: string | null;
  walkMinutes: number | null;
  bus: boolean;
  /** この物件（部屋）が何件の掲載として見えているか */
  count: number;
  minPrice: number;
  maxPrice: number;
  priceCutCountMax: number;
  relistedCountMax: number;
  // ---- 賃貸だけ（売買のグループでは null / false）----
  adminFeeMin: number | null;
  adminFeeMax: number | null;
  depositMin: number | null;
  keyMoneyMin: number | null;
  /** グループの中に 1 件でもペット相談可があれば true */
  petsAllowed: boolean;
  /** 一番新しい情報公開日（読めたときだけ） */
  latestListedOn: string | null;
  /** 一番早い first_seen（この部屋が最初に見えた日） */
  earliestFirstSeen: string;
  /** 一番遅い first_seen（新着順ソートに使う） */
  latestFirstSeen: string;
  latestLastSeen: string;
  urls: string[];
  listings: ListingPickRow[];
}

const AREA_TOLERANCE = 0.5;

/**
 * 建物名（正規化）＋間取り＋築年が同じ行を、専有面積が近い（±0.5㎡）ものどうしでまとめる。
 * 建物名が読めない行（null・空）は、他の物件と誤って混ざらないよう external_id ごとに単独グループにする。
 */
export function groupListings(rows: ListingPickRow[]): ListingGroup[] {
  const buckets = new Map<string, ListingPickRow[]>();
  for (const r of rows) {
    const norm = normalizeBuildingName(r.building_name);
    const plan = (r.floor_plan ?? "").trim();
    const year = r.building_year ?? "";
    const bucketKey = norm ? `${norm}\t${plan}\t${year}` : `__solo__\t${r.source}\t${r.external_id}`;
    const arr = buckets.get(bucketKey);
    if (arr) arr.push(r);
    else buckets.set(bucketKey, [r]);
  }

  const groups: ListingGroup[] = [];
  for (const [bucketKey, items] of buckets) {
    const withArea = items.filter((r) => r.area_sqm !== null).sort((a, b) => (a.area_sqm as number) - (b.area_sqm as number));
    const withoutArea = items.filter((r) => r.area_sqm === null);
    const clusters: ListingPickRow[][] = [];
    let cluster: ListingPickRow[] = [];
    let refArea: number | null = null;
    for (const r of withArea) {
      const area = r.area_sqm as number;
      if (cluster.length > 0 && refArea !== null && area - refArea <= AREA_TOLERANCE) {
        cluster.push(r);
      } else {
        if (cluster.length > 0) clusters.push(cluster);
        cluster = [r];
        refArea = area;
      }
    }
    if (cluster.length > 0) clusters.push(cluster);
    for (const r of withoutArea) clusters.push([r]);
    for (const c of clusters) groups.push(buildGroup(bucketKey, c));
  }
  return groups;
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function minOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && x !== undefined);
  return v.length ? Math.min(...v) : null;
}
function maxOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && x !== undefined);
  return v.length ? Math.max(...v) : null;
}

function buildGroup(key: string, items: ListingPickRow[]): ListingGroup {
  const first = items[0]!;
  const prices = items.map((r) => r.current_price);
  const urls = [...new Set(items.map((r) => r.url).filter((u): u is string => !!u))];
  const areas = items.map((r) => r.area_sqm).filter((a): a is number => a !== null);
  const avgArea = areas.length ? Math.round((areas.reduce((s, a) => s + a, 0) / areas.length) * 100) / 100 : null;
  return {
    key,
    buildingName: mostCommon(items.map((r) => r.building_name)) ?? first.building_name ?? "(建物名不明)",
    wardCode: mostCommon(items.map((r) => r.ward_code)),
    districtName: mostCommon(items.map((r) => r.district_name)),
    address: mostCommon(items.map((r) => r.address)),
    areaSqm: avgArea,
    floorPlan: mostCommon(items.map((r) => r.floor_plan)),
    buildingYear: first.building_year,
    builtMonth: (() => {
      const s = mostCommon(items.map((r) => (r.built_month === null ? null : String(r.built_month))));
      return s === null ? null : Number(s);
    })(),
    lineName: mostCommon(items.map((r) => r.line_name)),
    stationName: mostCommon(items.map((r) => r.station_name)),
    walkMinutes: (() => {
      const ws = items.map((r) => r.walk_minutes).filter((w): w is number => w !== null);
      return ws.length ? Math.min(...ws) : null;
    })(),
    bus: items.every((r) => !!r.bus),
    count: items.length,
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    priceCutCountMax: Math.max(...items.map((r) => r.price_cut_count)),
    relistedCountMax: Math.max(...items.map((r) => r.relisted_count)),
    adminFeeMin: minOf(items.map((r) => r.admin_fee ?? null)),
    adminFeeMax: maxOf(items.map((r) => r.admin_fee ?? null)),
    depositMin: minOf(items.map((r) => r.deposit ?? null)),
    keyMoneyMin: minOf(items.map((r) => r.key_money ?? null)),
    petsAllowed: items.some((r) => !!r.pets_allowed),
    latestListedOn: items.map((r) => r.listed_on ?? null).filter((v): v is string => !!v).sort().slice(-1)[0] ?? null,
    earliestFirstSeen: items.map((r) => r.first_seen).sort()[0]!,
    latestFirstSeen: items.map((r) => r.first_seen).sort().slice(-1)[0]!,
    latestLastSeen: items.map((r) => r.last_seen).sort().slice(-1)[0]!,
    urls,
    listings: items,
  };
}

/**
 * 並べ替えに要る最小限の形。ListingGroup（グルーピング直後）も /api/listings/picks のカードもこれを満たすので、
 * どちらもそのまま並べられる。retention は価格維持（無い・計算できないものは null / 省略）。
 */
export interface SortableGroup {
  latestFirstSeen: string;
  minPrice: number;
  retention?: { value: number } | null;
}

function compareNewest(a: SortableGroup, b: SortableGroup): number {
  if (a.latestFirstSeen !== b.latestFirstSeen) return a.latestFirstSeen < b.latestFirstSeen ? 1 : -1;
  return a.minPrice - b.minPrice;
}

/** 新着順（グループの最新 first_seen が新しい順）。同着は価格が安い順 */
export function sortGroupsNewestFirst<T extends SortableGroup>(groups: readonly T[]): T[] {
  return [...groups].sort(compareNewest);
}

/** 価格維持の高い順。価格維持が無いものは末尾（その中は新着順）。同値も新着順→価格が安い順 */
export function sortGroupsByRetention<T extends SortableGroup>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => {
    const ra = a.retention?.value ?? null;
    const rb = b.retention?.value ?? null;
    if (ra === null && rb !== null) return 1;
    if (ra !== null && rb === null) return -1;
    if (ra !== null && rb !== null && ra !== rb) return rb - ra;
    return compareNewest(a, b);
  });
}

export function sortPicks<T extends SortableGroup>(groups: readonly T[], sort: PickSort): T[] {
  return sort === "retention" ? sortGroupsByRetention(groups) : sortGroupsNewestFirst(groups);
}

// ---------------------------------------------------------------- 住所 → 町名（地区名）

/** 旧字・異体字を台帳（src/wards.ts）側の表記に寄せる（src/suumo.ts municipalityCodeFromAddress と同じ扱い） */
function canonicalizeAddress(addr: string): string {
  return addr
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/^福岡県/, "")
    .replace(/糟屋郡/g, "粕屋郡")
    .replace(/須惠町/g, "須恵町");
}

/** 長い名前から先に試す（「春日市」より先に…のような前方一致の取り違えを避ける） */
const MUNICIPALITY_PREFIXES: string[] = AREAS.flatMap((a) =>
  a.group === "city" ? [`福岡市${a.name}`, a.name] : [`粕屋郡${a.name}`, a.name],
).sort((x, y) => y.length - x.length);

const KANJI_NUM = "〇一二三四五六七八九十百";

/**
 * 地区名の突き合わせキー。国交省 XIT001 の DistrictName（丁目を含まない町名。例「千早」「藤崎」）と、
 * districtNameFromAddress の結果の両方をこれに通してから比べる。
 * 全角/半角・空白を揃え、先頭の「大字」「字」を落とし、「ヶ」「ヵ」「ケ」を揃える（どちらの表記でも同じ地区になるように）。
 */
export function normalizeDistrictKey(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/[ヶヵ]/g, "ケ")
    .replace(/^大字/, "")
    .replace(/^字/, "");
}

/**
 * SUUMO の住所文字列から町名（丁目・番地を除いた地区名）を起こす。
 * SUUMO の掲載は地区名を持たない（listings.district_name は常に NULL）ので、XIT001 の DistrictName と
 * 突き合わせるためにここで作る。読めなければ null。
 *
 * 吸収する表記ゆれ:
 * - 県名・市名・郡名の有無（「福岡県福岡市東区千早４」「東区千早4丁目」「福岡市東区千早」）
 * - 全角/半角数字、丁目の有無（「千早４」「千早4丁目」「千早四丁目」「千早4-1-2」）
 * - 旧字（「糟屋郡須惠町」）、先頭の「大字」「字」
 * - 台帳に無い市区町村でも「〇〇市△△町」「〇〇郡〇〇町△△」の形なら市区町村部分を落とす
 * 町名に漢数字を含むもの（「二日市南」「五十川」「三苫」）は、漢数字の直後が「丁目」のときだけ切る。
 */
export function districtNameFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  let s = canonicalizeAddress(address);

  const known = MUNICIPALITY_PREFIXES.find((p) => s.startsWith(p));
  if (known) {
    s = s.slice(known.length);
  } else {
    // 台帳に無い市区町村: 「〇〇市」→（政令市なら）「〇〇区」、または「〇〇郡〇〇町/村」を落とす
    const m = /^(?:[^\d市郡]{1,6}郡[^\d町村]{1,6}[町村]|[^\d市]{1,6}市(?:[^\d区]{1,4}区)?)/.exec(s);
    if (!m) return null;
    s = s.slice(m[0].length);
  }

  s = s.replace(/^大字/, "").replace(/^字/, "");
  // 丁目・番地より前（最初の数字、または「漢数字+丁目」の手前）で切る
  const cut = new RegExp(`(\\d|[${KANJI_NUM}]+丁目|丁目|番地|[-‐－ー―の]\\d)`).exec(s);
  if (cut) s = s.slice(0, cut.index);
  s = s.replace(/[-‐－―]+$/, "");
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------- 価格維持

export type RetentionLevel = "district" | "municipality";

export interface PickRetention {
  /** district = 地区（町名）の値 / municipality = 地区の件数が足りず市区町村の値に落とした */
  level: RetentionLevel;
  /** 直近8四半期の㎡単価中央値 ÷ その前8四半期の中央値 */
  value: number;
  /** 値を取った範囲の名前（地区なら町名、市区町村なら市区町村名） */
  areaName: string;
  nRecent: number;
  nPrior: number;
}

/**
 * 地区の窓を「突き合わせキー」で引けるようにする。
 * windows のキーは `${市区町村コード}\t${district_name}`（src/metrics.ts buildMetricsWithWindows）。
 * 「大字◯◯」「◯◯」のように同じキーに落ちるものが複数あれば、直近の件数が多い方を採る。
 */
export function indexDistrictWindows(windows: Map<string, Windowed>): Map<string, { name: string; w: Windowed }> {
  const out = new Map<string, { name: string; w: Windowed }>();
  for (const [key, w] of windows) {
    const [code = "", district = ""] = key.split("\t");
    const norm = normalizeDistrictKey(district);
    if (!code || !norm) continue;
    const k = `${code}\t${norm}`;
    const cur = out.get(k);
    if (!cur || w.nRecent > cur.w.nRecent) out.set(k, { name: district, w });
  }
  return out;
}

/**
 * カード 1 枚の価格維持。地区の値が最低件数（直近8件・前期5件）を満たせば地区、
 * そうでなければ市区町村（直近20件・前期10件）、どちらも無ければ null。
 */
export function pickRetention(
  wardCode: string | null,
  districtName: string | null,
  districtIndex: Map<string, { name: string; w: Windowed }>,
  wardWindows: Map<string, Windowed>,
  municipalityName: (code: string) => string | null,
): PickRetention | null {
  if (!wardCode) return null;
  const norm = normalizeDistrictKey(districtName);
  if (norm) {
    const d = districtIndex.get(`${wardCode}\t${norm}`);
    if (d && districtHasEnoughSales(d.w)) {
      return { level: "district", value: retentionOf(d.w) as number, areaName: d.name, nRecent: d.w.nRecent, nPrior: d.w.nPrior };
    }
  }
  const m = wardWindows.get(wardCode);
  if (m && municipalityHasEnoughSales(m)) {
    return {
      level: "municipality",
      value: retentionOf(m) as number,
      areaName: municipalityName(wardCode) ?? wardCode,
      nRecent: m.nRecent,
      nPrior: m.nPrior,
    };
  }
  return null;
}

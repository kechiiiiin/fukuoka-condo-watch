// 「条件に合う新着・掲載中の物件」ビュー（/listings/picks・/api/listings/picks）のうち、
// D1 に触らない純粋関数。src/listing-picks.ts から使う。test/listing-grouping.test.ts で直接テストする
// （tsconfig.test.json の include に入れている）。
//
// 同じ部屋が複数の仲介業者から別の external_id で重複掲載されるため（例: アンピール空港南が 11 件）、
// 建物名（正規化）＋専有面積（±0.5㎡）＋間取り＋築年でグルーピングして 1 枚のカードにまとめる。

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
  /** 駅からの徒歩分の上限 */
  walkMax: number;
  /** true ならバス便の物件も許す。既定は除外 */
  includeBus: boolean;
  /** 対象の市区町村コード（null = すべて） */
  municipalities: string[] | null;
  /** true なら新着（first_seen が直近 freshDays 日以内）だけ */
  freshOnly: boolean;
  /** 「新着」とみなす日数 */
  freshDays: number;
}

export const DEFAULT_PICK_FILTERS: Omit<PickFilters, "municipalities"> & { municipalities: null } = {
  priceMaxMan: 3600,
  areaMin: 65,
  planRoomsMin: 3,
  includeDK: false,
  ageMax: 25,
  walkMax: 10,
  includeBus: false,
  municipalities: null,
  freshOnly: false,
  freshDays: 7,
};

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

export function parsePickFilters(params: URLSearchParams, isAreaCode: (v: string) => boolean): PickFilters {
  return {
    priceMaxMan: num(params, "pmax") ?? DEFAULT_PICK_FILTERS.priceMaxMan,
    areaMin: num(params, "amin") ?? DEFAULT_PICK_FILTERS.areaMin,
    planRoomsMin: num(params, "plan") ?? DEFAULT_PICK_FILTERS.planRoomsMin,
    includeDK: bool(params, "dk", DEFAULT_PICK_FILTERS.includeDK),
    ageMax: num(params, "age") ?? DEFAULT_PICK_FILTERS.ageMax,
    walkMax: num(params, "walk") ?? DEFAULT_PICK_FILTERS.walkMax,
    includeBus: bool(params, "bus", DEFAULT_PICK_FILTERS.includeBus),
    municipalities: parseMunicipalities(params, isAreaCode),
    freshOnly: bool(params, "fresh", DEFAULT_PICK_FILTERS.freshOnly),
    freshDays: DEFAULT_PICK_FILTERS.freshDays,
  };
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
  } else if (row.walk_minutes === null || row.walk_minutes > f.walkMax) {
    return false;
  }

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
    earliestFirstSeen: items.map((r) => r.first_seen).sort()[0]!,
    latestFirstSeen: items.map((r) => r.first_seen).sort().slice(-1)[0]!,
    latestLastSeen: items.map((r) => r.last_seen).sort().slice(-1)[0]!,
    urls,
    listings: items,
  };
}

/** 新着順（グループの最新 first_seen が新しい順）。同着は価格が安い順 */
export function sortGroupsNewestFirst(groups: ListingGroup[]): ListingGroup[] {
  return [...groups].sort((a, b) => {
    if (a.latestFirstSeen !== b.latestFirstSeen) return a.latestFirstSeen < b.latestFirstSeen ? 1 : -1;
    return a.minPrice - b.minPrice;
  });
}

// バス直通マップ（/listings/bus）の判定ロジック。正規化規則・目的地・範囲・判定はすべてこのファイルに置く。
// 入力は国土数値情報 P11 バス停留所（2022年度・福岡県）。build-bus-access.ts が読み、check-bus-access.ts が検算に使う。
//
// ■ 判定のしかた（乗り換えなしで行けるか）
//   1. 目的地ごとに「目的地バス停」= DESTINATIONS の中心から radiusM 以内のバス停（範囲外の市町村も含め全バス停から拾う）
//   2. 各バス停の系統名を normalizeRouteKeys で正規化し、「事業者名|系統番号」のキーにする（routeKey）
//   3. 目的地バス停が持つキーの和集合を作り、あるバス停のキーと 1 つでも重なれば「その目的地へ直通の系統あり」
//   ※ 方向（上り・下り）・経由・行先の違いは区別しない。同じ番号でも途中で折り返す便は拾ってしまう＝多めに出る推定
//
// ■ 系統名の正規化規則（normalizeRouteKeys）
//   P11 の系統名は「41」「38系統」「快速113・8」「4［千早駅〜天神］」「30・32［イオン→大濠公園］」「21系統-1」のように揺れる。
//   a. NFKC で全角英数・全角括弧を半角に寄せる（「［］」→「[]」・「（）」→「()」）
//   b. 区間・行先の注記「[…]」「(…)」を消す（表示用には元の系統名を別に残す）
//   c. 種別の語 ROUTE_NOISE_WORDS（系統・循環・快速・特快・急行・直行・都高・深夜）を消す。「21系統-1」→「21-1」
//   d. 「・」で分割し、それぞれを 1 つの系統番号とみなす（「113・8」→ 113 と 8）。
//      併記は「113 番が 8 番の経路を通る」などの意味のことがあり、分割すると多めに出る側へ倒れる（取りこぼすより良い）
//   e. 「-1」「B」「N」などの枝番・記号は残す（「37」と「37-1」は別系統）。前後の空白を詰め、空は捨てる
//   f. 数字を含まない名前（「ウエストコーストライナー」「直方線 本線」「天神→片江営」）はそのまま 1 つのキーにする
//   キーには事業者名を付ける（西日本鉄道の 3 番と西鉄バス二日市の 3 番は別）。

export type DestKey = "tenjin" | "gion" | "higashi";

export interface Destination {
  key: DestKey;
  label: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** 中心の決め方（出典） */
  note: string;
}

/** 目的地（中心・半径はここだけで定義する） */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: "tenjin",
    label: "天神",
    // 地下鉄天神駅（Wikipedia 天神駅: 33.5914889, 130.3993583）と西鉄福岡（天神）駅（天神2丁目11-1・国土地理院ジオコーダ 33.59042, 130.398895）の中点
    lat: 33.59096,
    lng: 130.39913,
    radiusM: 600,
    note: "地下鉄天神駅と西鉄福岡（天神）駅の中点",
  },
  {
    key: "gion",
    label: "祇園",
    lat: 33.59468,
    lng: 130.41301,
    radiusM: 400,
    note: "祇園NKビル（職場）",
  },
  {
    key: "higashi",
    label: "東福岡",
    // 東福岡高校・東福岡自彊館中学校 〒812-0007 福岡市博多区東比恵2丁目24-1（学校公式 https://www.higashifukuoka.ed.jp/information/access.html）
    // 座標は国土地理院ジオコーダ「福岡市博多区東比恵2丁目24-1」→「東比恵二丁目２４番１号」130.429932, 33.594261（2026-10-31 取得）
    lat: 33.594261,
    lng: 130.429932,
    radiusM: 500,
    note: "東福岡高校・東福岡自彊館中学校（博多区東比恵2丁目24-1）",
  },
];

/** 範囲に入れる市区町村（N03 行政区域の N03_007 = 全国地方公共団体コード） */
export const FUKUOKA_CITY_CODES = ["40131", "40132", "40133", "40134", "40135", "40136", "40137"] as const;
export const ITOSHIMA_CODE = "40230";
export const AREA_LABELS: Record<string, string> = {
  "40131": "東区",
  "40132": "博多区",
  "40133": "中央区",
  "40134": "南区",
  "40135": "西区",
  "40136": "城南区",
  "40137": "早良区",
  "40230": "糸島市",
};

/** 糸島市は JR 筑肥線のこの 3 駅から ITOSHIMA_RADIUS_M 以内のバス停だけ入れる */
export const ITOSHIMA_STATIONS = [
  // Wikipedia 波多江駅「北緯33度33分50.67秒 東経130度13分36.53秒」
  { name: "波多江", lat: 33.564075, lng: 130.226814 },
  // 国土地理院ジオコーダ「糸島高校前駅」
  { name: "糸島高校前", lat: 33.560592, lng: 130.213566 },
  // 国土地理院ジオコーダ「筑前前原駅」
  { name: "筑前前原", lat: 33.557037, lng: 130.199683 },
] as const;
export const ITOSHIMA_RADIUS_M = 2000;

/** 系統名から消す種別の語（規則 c） */
export const ROUTE_NOISE_WORDS = ["系統", "循環", "快速", "特快", "急行", "直行", "都高", "深夜"] as const;

/** 規則 a〜f。1 つの系統名から系統番号（事業者名なし）の配列を返す */
export function normalizeRouteKeys(raw: string): string[] {
  let s = raw.normalize("NFKC");
  s = s.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "");
  for (const w of ROUTE_NOISE_WORDS) s = s.split(w).join("");
  const out: string[] = [];
  for (const part of s.split("・")) {
    const t = part.replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** P11_003_01〜35 は 1 本の長い文字列を区切って入れてあるので、つないでからカンマで分ける */
export function splitRouteField(fields: (string | null | undefined)[]): string[] {
  return fields
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(",")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export const routeKey = (operator: string, route: string) => `${operator}|${route}`;

const R_EARTH = 6371008.8;
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export const nearItoshimaStation = (lat: number, lng: number) =>
  ITOSHIMA_STATIONS.some((st) => distanceM(lat, lng, st.lat, st.lng) <= ITOSHIMA_RADIUS_M);

// ---- 判定（規則 1〜3） ----

/** 1 つのバス停（同名・同座標の事業者違いはまとめた後） */
export interface StopInput {
  name: string;
  lat: number;
  lng: number;
  /** 事業者ごとの系統名（元の表記） */
  routes: { operator: string; raw: string }[];
}

export interface StopJudgement {
  /** 目的地ごとに「直通あり」か */
  reach: Record<DestKey, boolean>;
  /** 目的地ごとの一致した系統名（元の表記・重複なし・最大 maxRoutes 件） */
  matched: Record<DestKey, string[]>;
  /** このバス停自身が目的地バス停か */
  isDest: Record<DestKey, boolean>;
}

const stopKeys = (s: StopInput) => {
  const m = new Map<string, string[]>(); // key → 元の系統名
  for (const r of s.routes) {
    for (const k of normalizeRouteKeys(r.raw)) {
      const key = routeKey(r.operator, k);
      const list = m.get(key) ?? [];
      if (!list.includes(r.raw)) list.push(r.raw);
      m.set(key, list);
    }
  }
  return m;
};

/** 目的地バス停（全バス停から半径内を拾う）と、そのキーの和集合 */
export function destinationKeySets(all: StopInput[]) {
  const sets = {} as Record<DestKey, { keys: Set<string>; stops: string[] }>;
  for (const d of DESTINATIONS) {
    const keys = new Set<string>();
    const stops: string[] = [];
    for (const s of all) {
      if (distanceM(s.lat, s.lng, d.lat, d.lng) > d.radiusM) continue;
      stops.push(s.name);
      for (const k of stopKeys(s).keys()) keys.add(k);
    }
    sets[d.key] = { keys, stops: [...new Set(stops)] };
  }
  return sets;
}

export function judgeStop(
  s: StopInput,
  sets: ReturnType<typeof destinationKeySets>,
  maxRoutes = 4,
): StopJudgement {
  const keys = stopKeys(s);
  const reach = {} as Record<DestKey, boolean>;
  const matched = {} as Record<DestKey, string[]>;
  const isDest = {} as Record<DestKey, boolean>;
  for (const d of DESTINATIONS) {
    const names: string[] = [];
    for (const [k, raws] of keys) {
      if (!sets[d.key].keys.has(k)) continue;
      for (const r of raws) if (!names.includes(r)) names.push(r);
    }
    reach[d.key] = names.length > 0;
    matched[d.key] = names.slice(0, maxRoutes);
    isDest[d.key] = distanceM(s.lat, s.lng, d.lat, d.lng) <= d.radiusM;
  }
  return { reach, matched, isDest };
}

// ---- 出力 JSON の形（src/bus-access-dashboard.ts が読む） ----

export interface BusAccessStop {
  /** 停留所名 */
  n: string;
  lat: number;
  lng: number;
  /** 事業者名（BusAccessData.operators の添字） */
  o: number[];
  /** 区・市（AREA_LABELS のコード） */
  a: string;
  /** 直通あり: DESTINATIONS の順に bit 0,1,2 */
  f: number;
  /** 目的地バス停: 同じ bit の並び */
  d: number;
  /** 一致した系統名（DESTINATIONS の順・各最大 4 件） */
  r: string[][];
}

export interface BusAccessData {
  source: string;
  generatedAt: string;
  destinations: { key: DestKey; label: string; lat: number; lng: number; radiusM: number; note: string; stops: string[] }[];
  itoshimaStations: { name: string; lat: number; lng: number }[];
  itoshimaRadiusM: number;
  operators: string[];
  stops: BusAccessStop[];
}

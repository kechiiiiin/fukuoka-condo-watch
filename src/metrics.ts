import { hasReinfolibKey, type Env } from "./env";
import { XIT001_SOURCE } from "./ingest";
import {
  futurePopChange,
  pickLatestQuarter,
  rentScores,
  SELL_STATUS_LABEL,
  sellScores,
  stationPassengerChange,
  wardSellResults,
  windowBounds,
  type Windowed,
} from "./scoring";

export { percentile } from "./scoring";
import { AREAS, GROUP_LABEL, areasInScope, isAreaCode, parseScope, type Scope } from "./wards";

export const AGE_BANDS = [
  { id: "0-10", label: "築0-10年", lo: 0, hi: 10 },
  { id: "10-20", label: "築10-20年", lo: 10, hi: 20 },
  { id: "20-30", label: "築20-30年", lo: 20, hi: 30 },
  { id: "30+", label: "築30年超", lo: 30, hi: 1000 },
] as const;

export const PRICE_BANDS: { id: string; label: string; hi: number | null }[] = [
  { id: "p0", label: "〜1千万", hi: 1000 },
  { id: "p1", label: "1〜2千万", hi: 2000 },
  { id: "p2", label: "2〜3千万", hi: 3000 },
  { id: "p3", label: "3〜4千万", hi: 4000 },
  { id: "p4", label: "4〜5千万", hi: 5000 },
  { id: "p5", label: "5〜7千万", hi: 7000 },
  { id: "p6", label: "7千万〜", hi: null },
];

const ESTAT_PENDING = "e-Stat からの取り込み待ち（アプリケーション ID 未設定・scripts/estat-indicators.json の表が未検証）";

export const RENT_COMPONENTS = [
  {
    id: "future_pop_change",
    label: "将来人口の増減 2020→2040",
    weight: 20,
    higherIsBetter: true,
    source: "不動産情報ライブラリ XKT013",
    pendingReason: "未取得（npm run load-geo -- --remote --only future-pop）",
  },
  { id: "pop_change_2015_2020", label: "人口増減 2015→2020", weight: 15, higherIsBetter: true, source: "e-Stat 国勢調査", pendingReason: ESTAT_PENDING },
  { id: "single_household_rate", label: "単独世帯の割合", weight: 20, higherIsBetter: true, source: "e-Stat 国勢調査", pendingReason: ESTAT_PENDING },
  {
    id: "vacant_rental_rate",
    label: "賃貸用空き家率",
    weight: 25,
    higherIsBetter: false,
    source: "e-Stat 住宅・土地統計調査",
    pendingReason: ESTAT_PENDING,
  },
  {
    id: "small_unit_share",
    label: "40㎡以下の取引の割合",
    weight: 20,
    higherIsBetter: true,
    source: "不動産情報ライブラリ XIT001",
    pendingReason: "選んだ価格の種類・範囲に直近8四半期の取引が無い",
  },
  {
    id: "station_passengers_change",
    label: "駅乗降客数の増減 2019→最新年（市区町村内の駅の合計）",
    weight: 10,
    higherIsBetter: true,
    source: "不動産情報ライブラリ XKT015",
    pendingReason: "駅と市区町村のひも付けが未取得（npm run load-geo -- --remote）",
  },
] as const;

export const DEFAULT_CAT = "contract";

export const FORMULAS = {
  sell:
    "売りやすさ = 100 ×（0.5 × 流動性の順位 + 0.5 × 価格維持の順位）。" +
    "流動性 = 直近8四半期の取引件数 ÷ 2（件/年）。価格維持 = 直近8四半期の㎡単価中央値 ÷ その前の8四半期の中央値。" +
    "直近 = 選んだ価格の種類でデータが揃っている最新の四半期まで（一部の市区町村にしか入っていない四半期は待つ）。" +
    "価格の種類の既定は成約価格（2021Q1〜・データのある 22 市区町村すべてにある）。取引価格は福岡市の区と春日市にしか無いので、福岡市の長期推移向け。" +
    "順位 = 表示範囲（福岡市のみ／近郊のみ／すべて）の候補の中でのパーセンタイル（0〜1）。" +
    "選んだ価格の種類でデータが無い市区町村は順位に入れず「データなし」、直近か前期が空なら「件数不足」、候補が3未満なら「比較対象不足」と表示する。" +
    "地区は直近8件以上・前期5件以上のみ。" +
    "件数は区・市町の人口規模に左右されるので、「すべて」で比べるときは価格維持も併せて見る。築年帯・価格・面積フィルタを掛けると同じ条件の物件どうしで比べられる。",
  rent:
    "貸しやすさ（市区町村単位）= 100 × Σ(重み × 指標の順位) ÷ Σ(使えた指標の重み)。" +
    "重み: 将来人口の増減 20・人口増減(国勢調査) 15・単独世帯の割合 20・賃貸用空き家率 25（低いほど良い）・40㎡以下の取引の割合 20・駅乗降客数の増減 10。" +
    "順位 = 表示範囲の市区町村の中でのパーセンタイル。値の無い指標（取り込み待ち・駅の無い町など）は除いて重みを割り直す。地区表の貸しやすさは所属する市区町村の値。",
};

type Cat = "transaction" | "contract" | "all";

export interface Filters {
  /** 表示範囲。all = すべて / city = 福岡市の区 / suburb = 近郊の市町 */
  scope: Scope;
  /** 1 つの市区町村に絞る（表示範囲に含まれるときだけ有効） */
  ward: string | null;
  age: string;
  pmin: number | null;
  pmax: number | null;
  amin: number | null;
  amax: number | null;
  cat: Cat;
  years: number;
}

export function parseFilters(url: URL): Filters {
  const p = url.searchParams;
  const num = (k: string): number | null => {
    const v = p.get(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const scope = parseScope(p.get("scope"));
  const ward = p.get("ward");
  const age = p.get("age") ?? "all";
  const cat = p.get("cat");
  const inScope = !!ward && isAreaCode(ward) && areasInScope(scope).some((a) => a.code === ward);
  return {
    scope,
    ward: inScope ? ward : null,
    age: AGE_BANDS.some((b) => b.id === age) ? age : "all",
    pmin: num("pmin"),
    pmax: num("pmax"),
    amin: num("amin"),
    amax: num("amax"),
    // 既定は成約価格（23 市区町村のうちデータのある 22 すべてにそろっている。取引価格は区と春日市だけ）
    cat: cat === "transaction" || cat === "all" ? cat : DEFAULT_CAT,
    years: Math.min(20, Math.max(2, Math.round(num("years") ?? 10))),
  };
}

const QI = "(year * 4 + quarter - 1)";
const AGE = "(year - building_year)";

type Bind = string | number;

/** 表示範囲の市区町村だけに絞る条件（all なら条件なし） */
function scopeClause(scope: Scope): { sql: string | null; binds: Bind[] } {
  if (scope === "all") return { sql: null, binds: [] };
  const codes = areasInScope(scope).map((a) => a.code);
  return { sql: `ward_code IN (${codes.map(() => "?").join(",")})`, binds: codes };
}

function whereClause(f: Filters, opt: { age?: boolean; ward?: boolean } = {}): { sql: string; binds: Bind[] } {
  const c: string[] = ["unit_price IS NOT NULL"];
  const binds: Bind[] = [];
  if (f.cat !== "all") {
    c.push("price_category = ?");
    binds.push(f.cat);
  }
  if (f.ward && opt.ward !== false) {
    c.push("ward_code = ?");
    binds.push(f.ward);
  } else {
    const s = scopeClause(f.scope);
    if (s.sql) {
      c.push(s.sql);
      binds.push(...s.binds);
    }
  }
  const band = AGE_BANDS.find((b) => b.id === f.age);
  if (band && opt.age !== false) {
    c.push(`building_year IS NOT NULL AND ${AGE} >= ? AND ${AGE} < ?`);
    binds.push(band.lo, band.hi);
  }
  if (f.pmin !== null) {
    c.push("trade_price >= ?");
    binds.push(f.pmin * 10000);
  }
  if (f.pmax !== null) {
    c.push("trade_price <= ?");
    binds.push(f.pmax * 10000);
  }
  if (f.amin !== null) {
    c.push("area_sqm >= ?");
    binds.push(f.amin);
  }
  if (f.amax !== null) {
    c.push("area_sqm <= ?");
    binds.push(f.amax);
  }
  return { sql: c.join(" AND "), binds };
}

/** inner は (分割列..., v) を返す SELECT。分割ごとの件数と中央値を返す（D1 = SQLite のウィンドウ関数） */
async function medians<T extends Record<string, unknown>>(
  env: Env,
  inner: string,
  binds: Bind[],
  parts: string[],
): Promise<(T & { n: number; med: number })[]> {
  const p = parts.join(", ");
  const sql =
    `WITH f AS (${inner}), ` +
    `r AS (SELECT ${p}, v, ROW_NUMBER() OVER (PARTITION BY ${p} ORDER BY v) AS rn, COUNT(*) OVER (PARTITION BY ${p}) AS cnt FROM f) ` +
    `SELECT ${p}, MAX(cnt) AS n, AVG(v) AS med FROM r WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2) GROUP BY ${p}`;
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<T & { n: number; med: number }>();
  return res.results;
}

export interface Status {
  reinfolibKey: boolean;
  rows: number;
  firstQi: number | null;
  latestQi: number | null;
  lastFetchedAt: string | null;
  recentErrors: { ward_code: string; year: number; quarter: number; error: string | null; fetched_at: string }[];
  rentStatsRows: number;
  stationRows: number;
  notices: string[];
}

export async function buildStatus(env: Env): Promise<Status> {
  const [agg, last, errs, stats, stations] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS rows, MIN(${QI}) AS firstQi, MAX(${QI}) AS latestQi FROM transactions`).first<{
      rows: number;
      firstQi: number | null;
      latestQi: number | null;
    }>(),
    env.DB.prepare("SELECT MAX(fetched_at) AS t FROM fetch_log WHERE source = ?").bind(XIT001_SOURCE).first<{ t: string | null }>(),
    env.DB.prepare(
      "SELECT ward_code, year, quarter, error, fetched_at FROM fetch_log WHERE status = 'error' ORDER BY fetched_at DESC LIMIT 5",
    ).all<Status["recentErrors"][number]>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM area_stats").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM station_passengers").first<{ n: number }>(),
  ]);
  const key = hasReinfolibKey(env);
  const rows = agg?.rows ?? 0;
  const notices: string[] = [];
  if (!key) notices.push("APIキー未設定（REINFOLIB_API_KEY）: 毎日の自動取り込みは止まっています");
  if (rows === 0) notices.push("取引データ未取得: scripts/backfill.ts で過去分を投入してください");
  if ((stats?.n ?? 0) === 0) notices.push("賃貸需要の統計が未取得: scripts/load-geo.ts・scripts/estat.ts を実行すると埋まります");
  return {
    reinfolibKey: key,
    rows,
    firstQi: agg?.firstQi ?? null,
    latestQi: agg?.latestQi ?? null,
    lastFetchedAt: last?.t ?? null,
    recentErrors: errs.results,
    rentStatsRows: stats?.n ?? 0,
    stationRows: stations?.n ?? 0,
    notices,
  };
}

function pairWindows(rows: { win: string; n: number; med: number }[], key: (r: never) => string): Map<string, Windowed> {
  const m = new Map<string, Windowed>();
  for (const r of rows) {
    const k = key(r as never);
    const cur = m.get(k) ?? { nRecent: 0, medRecent: null, nPrior: 0, medPrior: null };
    if (r.win === "recent") {
      cur.nRecent = r.n;
      cur.medRecent = r.med;
    } else {
      cur.nPrior = r.n;
      cur.medPrior = r.med;
    }
    m.set(k, cur);
  }
  return m;
}

export async function buildMetrics(env: Env, f: Filters) {
  const status = await buildStatus(env);
  /** 表示範囲の市区町村。ランキング（パーセンタイル）はこの中だけで付ける */
  const scoped = areasInScope(f.scope);

  // ---- 賃貸需要の入力（取引データが無くても出す） ----
  const statsRows = (
    await env.DB.prepare(
      "SELECT area_code, indicator, period, value, unit, source FROM area_stats WHERE area_level = 'municipality'",
    ).all<{
      area_code: string;
      indicator: string;
      period: string;
      value: number | null;
      unit: string | null;
      source: string;
    }>()
  ).results;
  const stationRows = (
    await env.DB.prepare("SELECT station_code, operator, line, name, year, passengers, area_code FROM station_passengers").all<{
      station_code: string;
      operator: string;
      line: string;
      name: string;
      year: number;
      passengers: number | null;
      area_code: string | null;
    }>()
  ).results;

  const catBinds: Bind[] = f.cat === "all" ? [] : [f.cat];
  // 直近の基準の四半期: 表示範囲で「データのある市区町村が揃っている」最新の四半期（src/scoring.ts pickLatestQuarter）
  const scLatest = scopeClause(f.scope);
  const latestConds = [f.cat === "all" ? null : "price_category = ?", scLatest.sql].filter((c): c is string => !!c);
  const coverageRows = (
    await env.DB.prepare(
      `SELECT ${QI} AS qi, COUNT(DISTINCT ward_code) AS areas FROM transactions ${latestConds.length ? `WHERE ${latestConds.join(" AND ")}` : ""}
       GROUP BY qi ORDER BY qi DESC LIMIT 12`,
    )
      .bind(...catBinds, ...scLatest.binds)
      .all<{ qi: number; areas: number }>()
  ).results;
  const L = pickLatestQuarter(coverageRows);

  let trend: { ward_code: string; qi: number; n: number; med: number }[] = [];
  let ageBands: { ward_code: string; band: string; n: number; med: number }[] = [];
  let priceBands: { ward_code: string; band: string; n: number }[] = [];
  let districts: {
    ward_code: string;
    district: string;
    nRecent: number;
    medRecent: number | null;
    nPrior: number;
    medPrior: number | null;
    liquidity: number;
    retention: number | null;
    sellScore: number | null;
    rentScore: number | null;
  }[] = [];
  const wardWindows = new Map<string, Windowed>();
  const smallShare = new Map<string, number>();

  if (L !== null) {
    const start = L - f.years * 4 + 1;
    const w = whereClause(f);
    trend = await medians<{ ward_code: string; qi: number }>(
      env,
      `SELECT ward_code, ${QI} AS qi, unit_price AS v FROM transactions WHERE ${w.sql} AND ${QI} >= ?`,
      [...w.binds, start],
      ["ward_code", "qi"],
    );

    const wa = whereClause(f, { age: false });
    ageBands = await medians<{ ward_code: string; band: string }>(
      env,
      `SELECT ward_code, CASE WHEN ${AGE} < 10 THEN '0-10' WHEN ${AGE} < 20 THEN '10-20' WHEN ${AGE} < 30 THEN '20-30' ELSE '30+' END AS band, unit_price AS v
       FROM transactions WHERE ${wa.sql} AND building_year IS NOT NULL AND ${AGE} >= 0 AND ${QI} > ?`,
      [...wa.binds, L - 8],
      ["ward_code", "band"],
    );

    const priceCase = PRICE_BANDS.map((b) =>
      b.hi === null ? `ELSE '${b.id}'` : `WHEN trade_price < ${b.hi * 10000} THEN '${b.id}'`,
    ).join(" ");
    priceBands = (
      await env.DB.prepare(
        `SELECT ward_code, CASE ${priceCase} END AS band, COUNT(*) AS n FROM transactions WHERE ${w.sql} AND ${QI} >= ? GROUP BY ward_code, band`,
      )
        .bind(...w.binds, start)
        .all<{ ward_code: string; band: string; n: number }>()
    ).results;

    // 直近8四半期 vs その前8四半期（1 市区町村への絞り込みは無視し、表示範囲の中で順位を付ける）
    // 直近 = L-7..L、前期 = L-15..L-8（L はデータの揃った最新の四半期なので、空の未来の四半期は窓に入らない）
    const wb = windowBounds(L);
    const wAll = whereClause(f, { ward: false });
    const winCase = `CASE WHEN ${QI} > ? THEN 'recent' ELSE 'prior' END`;
    const distRows = await medians<{ ward_code: string; district: string; win: string }>(
      env,
      `SELECT ward_code, COALESCE(district_name, '(地区不明)') AS district, ${winCase} AS win, unit_price AS v
       FROM transactions WHERE ${wAll.sql} AND ${QI} > ?`,
      [wb.recentAfter, ...wAll.binds, wb.priorAfter],
      ["ward_code", "district", "win"],
    );
    const wardRows = await medians<{ ward_code: string; win: string }>(
      env,
      `SELECT ward_code, ${winCase} AS win, unit_price AS v FROM transactions WHERE ${wAll.sql} AND ${QI} > ?`,
      [wb.recentAfter, ...wAll.binds, wb.priorAfter],
      ["ward_code", "win"],
    );
    for (const [k, v] of pairWindows(wardRows, (r: { ward_code: string }) => r.ward_code)) wardWindows.set(k, v);

    const distMap = pairWindows(distRows, (r: { ward_code: string; district: string }) => `${r.ward_code}\t${r.district}`);
    const eligible = [...distMap.entries()]
      .filter(([, v]) => v.nRecent >= 8 && v.nPrior >= 5 && v.medRecent && v.medPrior)
      .map(([key, v]) => ({ key, liquidity: v.nRecent / 2, retention: (v.medRecent as number) / (v.medPrior as number) }));
    const dScores = sellScores(eligible);
    districts = [...distMap.entries()].map(([key, v]) => {
      const [ward_code = "", district = ""] = key.split("\t");
      return {
        ward_code,
        district,
        ...v,
        liquidity: v.nRecent / 2,
        retention: v.medRecent && v.medPrior ? v.medRecent / v.medPrior : null,
        sellScore: dScores.get(key) ?? null,
        rentScore: null,
      };
    });

    const sc = scopeClause(f.scope);
    const small = (
      await env.DB.prepare(
        `SELECT ward_code, COUNT(*) AS n, SUM(CASE WHEN area_sqm <= 40 THEN 1 ELSE 0 END) AS small
         FROM transactions WHERE ${QI} > ? ${f.cat === "all" ? "" : "AND price_category = ?"} ${sc.sql ? `AND ${sc.sql}` : ""} GROUP BY ward_code`,
      )
        .bind(L - 8, ...catBinds, ...sc.binds)
        .all<{ ward_code: string; n: number; small: number }>()
    ).results;
    for (const r of small) if (r.n > 0) smallShare.set(r.ward_code, (100 * r.small) / r.n);
  }

  // ---- 市区町村のスコア（表示範囲の中で順位付け） ----
  // データの無い市区町村は順位の母数に入れず、sellStatus で理由を返す（表からは消さない）
  const wardSell = wardSellResults(
    scoped.map((a) => a.code),
    wardWindows,
  );

  const latestStat = (code: string, indicator: string): number | null => {
    const rows = statsRows.filter((r) => r.area_code === code && r.indicator === indicator && r.value !== null);
    rows.sort((a, b) => (a.period < b.period ? 1 : -1));
    return rows[0]?.value ?? null;
  };
  const periodsOf = (code: string, indicator: string): Record<string, number | null> =>
    Object.fromEntries(statsRows.filter((r) => r.area_code === code && r.indicator === indicator).map((r) => [r.period, r.value]));

  const stationChange = stationPassengerChange(
    stationRows.map((r) => ({ key: `${r.station_code}|${r.operator}|${r.line}`, area_code: r.area_code, year: r.year, passengers: r.passengers })),
  );

  const componentValues = new Map<string, Record<string, number | null>>();
  for (const a of scoped) {
    componentValues.set(a.code, {
      future_pop_change: futurePopChange(periodsOf(a.code, "future_pop"))?.value ?? null,
      pop_change_2015_2020: latestStat(a.code, "pop_change_2015_2020"),
      single_household_rate: latestStat(a.code, "single_household_rate"),
      vacant_rental_rate: latestStat(a.code, "vacant_rental_rate"),
      small_unit_share: smallShare.get(a.code) ?? null,
      station_passengers_change: stationChange.get(a.code)?.value ?? null,
    });
  }
  const rent = rentScores(
    scoped.map((a) => a.code),
    componentValues,
    RENT_COMPONENTS,
  );
  const rentScore = rent.byArea;
  for (const d of districts) d.rentScore = rentScore.get(d.ward_code)?.score ?? null;

  /** どの指標が効いていて、どれが取り込み待ちか（画面に出す） */
  const rentComponentStatus = RENT_COMPONENTS.map((c) => {
    const areas = scoped.filter((a) => componentValues.get(a.code)?.[c.id] != null).length;
    const active = rent.active.has(c.id);
    return {
      id: c.id,
      label: c.label,
      weight: c.weight,
      source: c.source,
      active,
      areas,
      reason: active ? null : areas === 1 ? "値のある市区町村が 1 つだけで順位にならない" : c.pendingReason,
    };
  });

  const catLabel = f.cat === "contract" ? "成約価格" : f.cat === "transaction" ? "取引価格" : "両方";
  const categoryCoverage = {
    cat: f.cat,
    label: catLabel,
    noData: scoped.filter((a) => wardSell.get(a.code)?.status === "no_data").map((a) => a.name),
  };

  const ageMed = (code: string, band: string) => ageBands.find((r) => r.ward_code === code && r.band === band)?.med ?? null;
  const wardScores = scoped.map((a) => {
    const win = wardWindows.get(a.code);
    const a0 = ageMed(a.code, "0-10");
    const a2 = ageMed(a.code, "20-30");
    return {
      ward_code: a.code,
      name: a.name,
      group: a.group,
      subgroup: a.subgroup,
      sellScore: wardSell.get(a.code)?.score ?? null,
      /** ok | no_data（データなし）| insufficient（件数不足）| few_candidates（比較対象不足） */
      sellStatus: wardSell.get(a.code)?.status ?? "no_data",
      sellStatusLabel: (() => {
        const s = wardSell.get(a.code)?.status ?? "no_data";
        return s === "ok" ? null : SELL_STATUS_LABEL[s];
      })(),
      rentScore: rentScore.get(a.code)?.score ?? null,
      rentUsed: rentScore.get(a.code)?.used ?? [],
      liquidity: win ? win.nRecent / 2 : null,
      retention: win?.medRecent && win.medPrior ? win.medRecent / win.medPrior : null,
      medRecent: win?.medRecent ?? null,
      age20to30VsNew: a0 && a2 ? a2 / a0 : null,
      components: componentValues.get(a.code) ?? {},
    };
  });

  // ---- 駅 ----
  const stationMap = new Map<string, { name: string; operator: string; line: string; byYear: Record<number, number> }>();
  for (const r of stationRows) {
    const k = `${r.station_code}|${r.operator}|${r.line}`;
    const s = stationMap.get(k) ?? { name: r.name, operator: r.operator, line: r.line, byYear: {} };
    if (r.passengers !== null && r.passengers > 0) s.byYear[r.year] = r.passengers;
    stationMap.set(k, s);
  }
  const stations = [...stationMap.values()]
    .map((s) => {
      const years = Object.keys(s.byYear).map(Number).sort((a, b) => a - b);
      const ly = years[years.length - 1];
      const latestV = ly !== undefined ? (s.byYear[ly] ?? null) : null;
      const v2019 = s.byYear[2019] ?? null;
      const first = years[0];
      const firstV = first !== undefined ? (s.byYear[first] ?? null) : null;
      return {
        name: s.name,
        operator: s.operator,
        line: s.line,
        latestYear: ly ?? null,
        latest: latestV,
        vs2019: latestV && v2019 ? latestV / v2019 : null,
        firstYear: first ?? null,
        vsFirst: latestV && firstV ? latestV / firstV : null,
      };
    })
    .filter((s) => s.latest !== null)
    .sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0))
    .slice(0, 40);

  const scopedCodes = new Set(scoped.map((a) => a.code));
  return {
    status,
    filters: f,
    latestQi: L,
    /** 全対象市区町村（名前の引き当て・色の固定用） */
    areas: AREAS,
    groupLabels: GROUP_LABEL,
    /** 表示範囲の市区町村（旧 API 互換で wards という名前） */
    wards: scoped,
    ageBandDefs: AGE_BANDS,
    priceBandDefs: PRICE_BANDS,
    rentComponentDefs: RENT_COMPONENTS,
    rentComponentStatus,
    categoryCoverage,
    formulas: FORMULAS,
    trend,
    ageBands,
    priceBands,
    wardScores,
    districts: districts
      .filter((d) => (f.ward ? d.ward_code === f.ward : scopedCodes.has(d.ward_code)))
      .sort((a, b) => (b.sellScore ?? -1) - (a.sellScore ?? -1) || b.nRecent - a.nRecent)
      .slice(0, 150),
    stations,
  };
}

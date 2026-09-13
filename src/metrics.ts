import { hasReinfolibKey, type Env } from "./env";
import { XIT001_SOURCE } from "./ingest";
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

export const RENT_COMPONENTS = [
  { id: "future_pop_change", label: "将来人口の増減 2020→2040", weight: 20, higherIsBetter: true, source: "不動産情報ライブラリ XKT013" },
  { id: "pop_change_2015_2020", label: "人口増減 2015→2020", weight: 15, higherIsBetter: true, source: "e-Stat 国勢調査" },
  { id: "single_household_rate", label: "単独世帯の割合", weight: 20, higherIsBetter: true, source: "e-Stat 国勢調査" },
  { id: "vacant_rental_rate", label: "賃貸用空き家率", weight: 25, higherIsBetter: false, source: "e-Stat 住宅・土地統計調査" },
  { id: "small_unit_share", label: "40㎡以下の取引の割合", weight: 20, higherIsBetter: true, source: "不動産情報ライブラリ XIT001" },
] as const;

export const FORMULAS = {
  sell:
    "売りやすさ = 100 ×（0.5 × 流動性の順位 + 0.5 × 価格維持の順位）。" +
    "流動性 = 直近8四半期の取引件数 ÷ 2（件/年）。価格維持 = 直近8四半期の㎡単価中央値 ÷ その前の8四半期の中央値。" +
    "順位 = 表示範囲（福岡市のみ／近郊のみ／すべて）の候補の中でのパーセンタイル（0〜1）。地区は直近8件以上・前期5件以上のみ。" +
    "件数は区・市町の人口規模に左右されるので、「すべて」で比べるときは価格維持も併せて見る。築年帯・価格・面積フィルタを掛けると同じ条件の物件どうしで比べられる。",
  rent:
    "貸しやすさ（市区町村単位）= 100 × Σ(重み × 指標の順位) ÷ Σ(取得済み指標の重み)。" +
    "重み: 将来人口の増減 20・人口増減(国勢調査) 15・単独世帯の割合 20・賃貸用空き家率 25（低いほど良い）・40㎡以下の取引の割合 20。" +
    "順位 = 表示範囲の市区町村の中でのパーセンタイル。未取得の指標は除いて重みを割り直す。地区表の貸しやすさは所属する市区町村の値。",
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
    cat: cat === "contract" || cat === "all" ? cat : "transaction",
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

/** values の中で x がどの位置か（0〜1、同値は半分） */
export function percentile(values: number[], x: number): number {
  if (values.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (below + 0.5 * equal) / values.length;
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

interface Windowed {
  nRecent: number;
  medRecent: number | null;
  nPrior: number;
  medPrior: number | null;
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

function sellScores(cands: { key: string; liquidity: number; retention: number }[]): Map<string, number> {
  const liq = cands.map((c) => c.liquidity);
  const ret = cands.map((c) => c.retention);
  return new Map(
    cands.map((c) => [c.key, Math.round(100 * (0.5 * percentile(liq, c.liquidity) + 0.5 * percentile(ret, c.retention)))]),
  );
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
    await env.DB.prepare("SELECT station_code, operator, line, name, year, passengers FROM station_passengers").all<{
      station_code: string;
      operator: string;
      line: string;
      name: string;
      year: number;
      passengers: number | null;
    }>()
  ).results;

  const catCond = f.cat === "all" ? "" : "WHERE price_category = ?";
  const catBinds: Bind[] = f.cat === "all" ? [] : [f.cat];
  const latest = await env.DB.prepare(`SELECT MAX(${QI}) AS qi FROM transactions ${catCond}`)
    .bind(...catBinds)
    .first<{ qi: number | null }>();
  const L = latest?.qi ?? null;

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
    const wAll = whereClause(f, { ward: false });
    const winCase = `CASE WHEN ${QI} > ? THEN 'recent' ELSE 'prior' END`;
    const distRows = await medians<{ ward_code: string; district: string; win: string }>(
      env,
      `SELECT ward_code, COALESCE(district_name, '(地区不明)') AS district, ${winCase} AS win, unit_price AS v
       FROM transactions WHERE ${wAll.sql} AND ${QI} > ?`,
      [L - 8, ...wAll.binds, L - 16],
      ["ward_code", "district", "win"],
    );
    const wardRows = await medians<{ ward_code: string; win: string }>(
      env,
      `SELECT ward_code, ${winCase} AS win, unit_price AS v FROM transactions WHERE ${wAll.sql} AND ${QI} > ?`,
      [L - 8, ...wAll.binds, L - 16],
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
  const wardSellCands = [...wardWindows.entries()]
    .filter(([, v]) => v.medRecent && v.medPrior)
    .map(([key, v]) => ({ key, liquidity: v.nRecent / 2, retention: (v.medRecent as number) / (v.medPrior as number) }));
  const wardSell = sellScores(wardSellCands);

  const latestStat = (code: string, indicator: string): number | null => {
    const rows = statsRows.filter((r) => r.area_code === code && r.indicator === indicator && r.value !== null);
    rows.sort((a, b) => (a.period < b.period ? 1 : -1));
    return rows[0]?.value ?? null;
  };
  const statAt = (code: string, indicator: string, period: string): number | null =>
    statsRows.find((r) => r.area_code === code && r.indicator === indicator && r.period === period)?.value ?? null;

  const componentValues = new Map<string, Record<string, number | null>>();
  for (const a of scoped) {
    const p2020 = statAt(a.code, "future_pop", "2020");
    const p2040 = statAt(a.code, "future_pop", "2040");
    componentValues.set(a.code, {
      future_pop_change: p2020 && p2040 ? (100 * (p2040 - p2020)) / p2020 : null,
      pop_change_2015_2020: latestStat(a.code, "pop_change_2015_2020"),
      single_household_rate: latestStat(a.code, "single_household_rate"),
      vacant_rental_rate: latestStat(a.code, "vacant_rental_rate"),
      small_unit_share: smallShare.get(a.code) ?? null,
    });
  }
  const rentScore = new Map<string, { score: number | null; used: string[] }>();
  for (const a of scoped) {
    let num = 0;
    let den = 0;
    const used: string[] = [];
    for (const c of RENT_COMPONENTS) {
      const all = scoped.map((x) => componentValues.get(x.code)?.[c.id] ?? null).filter((v): v is number => v !== null);
      const mine = componentValues.get(a.code)?.[c.id] ?? null;
      if (all.length < 2 || mine === null) continue;
      const pr = percentile(all, mine);
      num += c.weight * (c.higherIsBetter ? pr : 1 - pr);
      den += c.weight;
      used.push(c.id);
    }
    rentScore.set(a.code, { score: den > 0 ? Math.round((100 * num) / den) : null, used });
  }
  for (const d of districts) d.rentScore = rentScore.get(d.ward_code)?.score ?? null;

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
      sellScore: wardSell.get(a.code) ?? null,
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

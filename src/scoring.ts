// スコア計算の純粋関数（D1 に触らない。test/scoring.test.ts から直接テストする）

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

/**
 * 「直近」の基準にする四半期を選ぶ。
 * 単純な MAX(四半期) だと、新しい四半期が一部の市区町村にだけ入った日（日次取り込みの途中・公表の揃わない四半期）に
 * 基準が先へ進み、まだ入っていない市区町村の直近 8 四半期に空の四半期が混ざって件数（流動性）が不当に下がる。
 * そこで「データのある市区町村数が、最近の四半期の最大値の半分以上ある最新の四半期」を基準にする。
 * rows = 四半期ごとの「その価格の種類のデータがある市区町村数」。空なら null（= データなし）。
 */
export function pickLatestQuarter(rows: { qi: number; areas: number }[]): number | null {
  const valid = rows.filter((r) => r.areas > 0).sort((a, b) => b.qi - a.qi);
  if (valid.length === 0) return null;
  const peak = Math.max(...valid.map((r) => r.areas));
  const need = Math.ceil(peak / 2);
  return (valid.find((r) => r.areas >= need) ?? valid[0])!.qi;
}

/** 直近 8 四半期（L-7..L）とその前 8 四半期（L-15..L-8）の境目。SQL の `qi > recentAfter` が直近、`qi > priorAfter` が対象範囲 */
export function windowBounds(latestQi: number): { recentAfter: number; priorAfter: number; recentFirst: number; priorFirst: number } {
  return { recentAfter: latestQi - 8, priorAfter: latestQi - 16, recentFirst: latestQi - 7, priorFirst: latestQi - 15 };
}

export interface Windowed {
  nRecent: number;
  medRecent: number | null;
  nPrior: number;
  medPrior: number | null;
}

/**
 * 市区町村の売りやすさの状態。
 * - ok: 順位を付けた
 * - no_data: 選んだ価格の種類でこの市区町村のデータが直近 16 四半期に 1 件も無い（例: 取引価格の近郊・どの種類でも久山町）
 * - insufficient: データはあるが直近か前期のどちらかが空で、価格維持が計算できない
 * - few_sales: 直近・前期のどちらかの件数が MIN_RECENT_SALES / MIN_PRIOR_SALES 未満（宇美町・須恵町のように年 2 件程度で
 *   1 件の値動きがそのままスコアを振り回す）。medRecent/medPrior は計算できるが件数が薄すぎるので順位に入れない
 * - few_candidates: 順位を付けられる市区町村が表示範囲に MIN_CANDIDATES 未満（1 つだけなら常に 50 点になり意味がない）
 */
export type SellStatus = "ok" | "no_data" | "insufficient" | "few_sales" | "few_candidates";

export const SELL_STATUS_LABEL: Record<Exclude<SellStatus, "ok">, string> = {
  no_data: "データなし",
  insufficient: "件数不足",
  few_sales: "件数不足",
  few_candidates: "比較対象不足",
};

export const MIN_CANDIDATES = 3;

/**
 * 市区町村の売りやすさに乗せる最低件数（直近8四半期・前8四半期）。
 * 本番 D1（2026-09-14・成約価格）の分布は、宇美町 4 件/須恵町 5 件（＝年 2〜2.5 件）から
 * 古賀市 30 件（＝年 15 件）へ一気に飛ぶ（30 市区町村中の外れ値は 2 つだけ）。
 * その谷間を跨ぐよう、直近 20 件（年 10 件）・前期 10 件（年 5 件）を境目にした。
 * 地区の 8 件/5 件より緩いのは意図的（市区町村は母数が大きいぶん、1 件の値動きの影響は小さくて済むため）。
 */
export const MIN_RECENT_SALES = 20;
export const MIN_PRIOR_SALES = 10;

export function sellScores(cands: { key: string; liquidity: number; retention: number }[]): Map<string, number> {
  const liq = cands.map((c) => c.liquidity);
  const ret = cands.map((c) => c.retention);
  return new Map(
    cands.map((c) => [c.key, Math.round(100 * (0.5 * percentile(liq, c.liquidity) + 0.5 * percentile(ret, c.retention)))]),
  );
}

/** 表示範囲の市区町村ごとに売りやすさを付ける。データの無い・薄い市区町村は順位の母数に入れず、状態で理由を返す */
export function wardSellResults(
  codes: string[],
  windows: Map<string, Windowed>,
): Map<string, { score: number | null; status: SellStatus }> {
  const out = new Map<string, { score: number | null; status: SellStatus }>();
  const cands: { key: string; liquidity: number; retention: number }[] = [];
  for (const code of codes) {
    const w = windows.get(code);
    if (!w || w.nRecent + w.nPrior === 0) {
      out.set(code, { score: null, status: "no_data" });
    } else if (!w.medRecent || !w.medPrior) {
      out.set(code, { score: null, status: "insufficient" });
    } else if (w.nRecent < MIN_RECENT_SALES || w.nPrior < MIN_PRIOR_SALES) {
      out.set(code, { score: null, status: "few_sales" });
    } else {
      cands.push({ key: code, liquidity: w.nRecent / 2, retention: w.medRecent / w.medPrior });
    }
  }
  if (cands.length < MIN_CANDIDATES) {
    for (const c of cands) out.set(c.key, { score: null, status: "few_candidates" });
    return out;
  }
  const scores = sellScores(cands);
  for (const c of cands) out.set(c.key, { score: scores.get(c.key) ?? null, status: "ok" });
  return out;
}

/**
 * 将来人口の増減率（%）。基準は 2020（XKT013 の PTN_2020 = 国勢調査人口）、無ければ収録の最も古い年。目標は 2040。
 * byPeriod = { "2020": 人口, "2025": 人口, ... }
 */
export function futurePopChange(byPeriod: Record<string, number | null | undefined>): { value: number; from: string; to: string } | null {
  const target = "2040";
  const years = Object.entries(byPeriod)
    .filter(([p, v]) => /^\d{4}$/.test(p) && typeof v === "number" && v > 0 && p < target)
    .map(([p]) => p)
    .sort();
  const from = years.includes("2020") ? "2020" : years[0];
  const base = from ? byPeriod[from] : null;
  const goal = byPeriod[target];
  if (!from || typeof base !== "number" || typeof goal !== "number" || base <= 0) return null;
  return { value: (100 * (goal - base)) / base, from, to: target };
}

/**
 * 市区町村内の駅の乗降客数の増減率（%）= 最新年の合計 ÷ 基準年（既定 2019・コロナ前）の合計 − 1。
 * 開業・廃止で母数が動かないよう、両方の年に値がある駅（事業者・路線別）だけで合計する。
 * 駅が市区町村にひも付いていない行（area_code NULL）は使わない。
 */
export function stationPassengerChange(
  rows: { key: string; area_code: string | null; year: number; passengers: number | null }[],
  baseYear = 2019,
): Map<string, { value: number; baseYear: number; latestYear: number; stations: number }> {
  const byArea = new Map<string, Map<string, Map<number, number>>>();
  for (const r of rows) {
    if (!r.area_code || r.passengers === null || !(r.passengers > 0)) continue;
    const st = byArea.get(r.area_code) ?? new Map<string, Map<number, number>>();
    const years = st.get(r.key) ?? new Map<number, number>();
    years.set(r.year, r.passengers);
    st.set(r.key, years);
    byArea.set(r.area_code, st);
  }
  const out = new Map<string, { value: number; baseYear: number; latestYear: number; stations: number }>();
  for (const [area, st] of byArea) {
    let latestYear = -Infinity;
    for (const years of st.values()) for (const y of years.keys()) if (y > latestYear) latestYear = y;
    if (!(latestYear > baseYear)) continue;
    let base = 0;
    let latest = 0;
    let n = 0;
    for (const years of st.values()) {
      const b = years.get(baseYear);
      const l = years.get(latestYear);
      if (b === undefined || l === undefined) continue;
      base += b;
      latest += l;
      n++;
    }
    if (n > 0 && base > 0) out.set(area, { value: 100 * (latest / base - 1), baseYear, latestYear, stations: n });
  }
  return out;
}

export interface RentComponentDef {
  id: string;
  weight: number;
  higherIsBetter: boolean;
}

/**
 * 貸しやすさの市区町村側の状態。
 * - ok: 2 指標以上・使えた指標の重みが有効指標の合計重みの MIN_RENT_WEIGHT_SHARE 以上あり、スコアを付けた
 * - insufficient: 材料が薄すぎる（久山町が将来人口 1 本＝重み 20/100 だけで 80 点になるような偏りを避ける）
 */
export type RentStatus = "ok" | "insufficient";

/** 貸しやすさに乗せる最低材料。1 指標だけの偏ったスコアを避けるため、指標数と重みシェアの両方を要求する */
export const MIN_RENT_COMPONENTS = 2;
export const MIN_RENT_WEIGHT_SHARE = 0.5;

/**
 * 貸しやすさ = 100 × Σ(重み × 順位) ÷ Σ(使えた指標の重み)。
 * 指標ごとに、表示範囲で値のある市区町村が 2 つ以上あるときだけ使う（1 つだけでは順位にならない） = active。
 * さらに市区町村ごとに、使えた指標が MIN_RENT_COMPONENTS 個以上・かつ有効指標の合計重みの MIN_RENT_WEIGHT_SHARE 以上を
 * 占めないと材料不足として score を null にする（1 指標だけに支えられた点数を出さないため）。
 */
export function rentScores(
  codes: string[],
  values: Map<string, Record<string, number | null>>,
  components: readonly RentComponentDef[],
): { byArea: Map<string, { score: number | null; used: string[]; status: RentStatus }>; active: Set<string> } {
  const active = new Set<string>();
  const pools = new Map<string, number[]>();
  for (const c of components) {
    const all = codes.map((code) => values.get(code)?.[c.id] ?? null).filter((v): v is number => v !== null);
    pools.set(c.id, all);
    if (all.length >= 2) active.add(c.id);
  }
  const totalActiveWeight = components.filter((c) => active.has(c.id)).reduce((s, c) => s + c.weight, 0);
  const byArea = new Map<string, { score: number | null; used: string[]; status: RentStatus }>();
  for (const code of codes) {
    let num = 0;
    let den = 0;
    const used: string[] = [];
    for (const c of components) {
      const mine = values.get(code)?.[c.id] ?? null;
      if (!active.has(c.id) || mine === null) continue;
      const pr = percentile(pools.get(c.id) ?? [], mine);
      num += c.weight * (c.higherIsBetter ? pr : 1 - pr);
      den += c.weight;
      used.push(c.id);
    }
    const enough = used.length >= MIN_RENT_COMPONENTS && totalActiveWeight > 0 && den >= MIN_RENT_WEIGHT_SHARE * totalActiveWeight;
    byArea.set(code, { score: enough ? Math.round((100 * num) / den) : null, used, status: enough ? "ok" : "insufficient" });
  }
  return { byArea, active };
}

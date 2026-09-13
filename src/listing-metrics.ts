// 掲載情報（SUUMO）の集計。/api/listings/metrics が返す。Access 保護下でだけ見える。
//
// - 掲載日数 = last_seen − first_seen + 1（掲載終了した物件だけで中央値。掲載終了日は「見えなくなった完走回の日付」）
// - 最初の完走回（ベースライン）に既にあった物件は、本当の掲載開始日が分からないので掲載日数の中央値から除く（censored）
// - 値下げ率 = 期間内に掲載中だった物件のうち、1 回以上値下げを観測した割合
// - 新着/日 = ベースラインより後に初出した件数 ÷ 期間内の完走回の数
// - ㎡単価の比較: 掲載中の売出㎡単価の中央値 ÷ 国交省 XIT001 取引価格の㎡単価中央値（直近 4 四半期）。
//   売出価格と成約（取引）価格は時点も構成も違うので「乖離の目安」。値付けの強気さ・弱気さを見る

import type { Env } from "./env";
import { jstToday } from "./ingest";
import { AGE_BANDS, PRICE_BANDS } from "./metrics";
import { SUUMO_SOURCE_ID } from "./suumo";
import { AREAS, areasInScope, GROUP_LABEL, parseScope } from "./wards";

interface Row {
  ward_code: string | null;
  building_year: number | null;
  area_sqm: number | null;
  current_price: number | null;
  price_cut_count: number;
  first_seen: string;
  last_seen: string;
  delisted_on: string | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

const dayMs = 86_400_000;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
export function addDays(d: string, n: number): string {
  return new Date((dayNum(d) + n) * dayMs).toISOString().slice(0, 10);
}

interface Acc {
  total: number;
  active: number;
  delisted: number;
  cut: number;
  dom: number[];
  censored: number;
  activeAge: number[];
  unitAsk: number[];
  priceMan: number[];
  fresh: number;
}
const acc = (): Acc => ({ total: 0, active: 0, delisted: 0, cut: 0, dom: [], censored: 0, activeAge: [], unitAsk: [], priceMan: [], fresh: 0 });

function summarize(a: Acc, completeRuns: number) {
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    total: a.total,
    active: a.active,
    delisted: a.delisted,
    domMedian: r1(median(a.dom)),
    domN: a.dom.length,
    censored: a.censored,
    activeAgeMedian: r1(median(a.activeAge)),
    priceCutRate: a.total ? Math.round((1000 * a.cut) / a.total) / 1000 : null,
    newPerDay: completeRuns > 0 ? Math.round((10 * a.fresh) / completeRuns) / 10 : null,
    askUnitMedian: a.unitAsk.length ? Math.round(median(a.unitAsk)!) : null,
    askPriceMedianMan: a.priceMan.length ? Math.round(median(a.priceMan)!) : null,
  };
}

export async function buildListingMetrics(env: Env, url: URL) {
  const p = url.searchParams;
  const scope = parseScope(p.get("scope") ?? "all");
  const daysReq = Number(p.get("days"));
  const days = Number.isFinite(daysReq) && daysReq > 0 ? Math.min(730, Math.max(7, Math.round(daysReq))) : 90;
  const today = jstToday();
  const since = addDays(today, -days);
  const areas = areasInScope(scope);
  const codes = new Set(areas.map((a) => a.code));
  const nowYear = Number(today.slice(0, 4));

  const [baselineRow, runsRes, rowsRes, txRes] = await Promise.all([
    env.DB.prepare("SELECT MIN(crawl_date) AS d FROM listing_crawl_runs WHERE source = ? AND status = 'complete'")
      .bind(SUUMO_SOURCE_ID)
      .first<{ d: string | null }>(),
    env.DB.prepare(
      `SELECT crawl_date, status, listings_seen, new_count, gone_count, price_change_count FROM listing_crawl_runs
       WHERE source = ? AND crawl_date >= ? ORDER BY crawl_date`,
    )
      .bind(SUUMO_SOURCE_ID, since)
      .all<{ crawl_date: string; status: string; listings_seen: number; new_count: number; gone_count: number; price_change_count: number }>(),
    env.DB.prepare(
      `SELECT ward_code, building_year, area_sqm, current_price, price_cut_count, first_seen, last_seen, delisted_on
       FROM listings WHERE source = ? AND (delisted_on IS NULL OR delisted_on >= ?)`,
    )
      .bind(SUUMO_SOURCE_ID, since)
      .all<Row>(),
    env.DB.prepare(
      `WITH mx AS (SELECT MAX(year * 4 + quarter - 1) AS q FROM transactions WHERE price_category = 'transaction'),
       f AS (SELECT t.ward_code, t.unit_price AS v FROM transactions t, mx
             WHERE t.price_category = 'transaction' AND t.unit_price IS NOT NULL AND (t.year * 4 + t.quarter - 1) > mx.q - 4),
       r AS (SELECT ward_code, v, ROW_NUMBER() OVER (PARTITION BY ward_code ORDER BY v) AS rn,
                    COUNT(*) OVER (PARTITION BY ward_code) AS cnt FROM f)
       SELECT ward_code, MAX(cnt) AS n, AVG(v) AS med, (SELECT q FROM mx) AS q FROM r
       WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2) GROUP BY ward_code`,
    ).all<{ ward_code: string; n: number; med: number; q: number | null }>(),
  ]);

  const baseline = baselineRow?.d ?? null;
  const completeRuns = runsRes.results.filter((r) => r.status === "complete" && r.crawl_date !== baseline).length;
  const byArea = new Map<string, Acc>();
  const byAge = new Map<string, Acc>();
  const byPrice = new Map<string, Acc>();
  const all = acc();
  const daily = new Map<string, { fresh: number; gone: number }>();

  for (const r of rowsRes.results) {
    if (!r.ward_code || !codes.has(r.ward_code)) continue;
    const priceMan = r.current_price !== null ? r.current_price / 10000 : null;
    const age = r.building_year !== null ? nowYear - r.building_year : null;
    const ageBand = age === null ? null : AGE_BANDS.find((b) => age >= b.lo && age < b.hi)?.id ?? null;
    const priceBand = priceMan === null ? null : PRICE_BANDS.find((b) => b.hi === null || priceMan < b.hi)?.id ?? null;
    const censored = baseline !== null && r.first_seen <= baseline;
    const targets = [all, get(byArea, r.ward_code), ageBand ? get(byAge, ageBand) : null, priceBand ? get(byPrice, priceBand) : null];
    for (const a of targets) {
      if (!a) continue;
      a.total++;
      if (r.price_cut_count > 0) a.cut++;
      if (r.delisted_on) {
        a.delisted++;
        if (censored) a.censored++;
        else a.dom.push(dayNum(r.last_seen) - dayNum(r.first_seen) + 1);
      } else {
        a.active++;
        if (!censored) a.activeAge.push(Math.max(1, dayNum(today) - dayNum(r.first_seen) + 1));
        if (r.area_sqm && r.current_price) a.unitAsk.push(r.current_price / r.area_sqm);
        if (priceMan !== null) a.priceMan.push(priceMan);
      }
      if (!censored && r.first_seen >= since) a.fresh++;
    }
    if (!censored && r.first_seen >= since) get2(daily, r.first_seen).fresh++;
    if (r.delisted_on) get2(daily, r.delisted_on).gone++;
  }

  const tx = new Map(txRes.results.map((t) => [t.ward_code, t]));
  const txQ = txRes.results[0]?.q ?? null;
  const areaRows = areas.map((a) => {
    const s = summarize(byArea.get(a.code) ?? acc(), completeRuns);
    const t = tx.get(a.code);
    const txUnit = t ? Math.round(t.med) : null;
    return {
      code: a.code,
      name: a.name,
      group: GROUP_LABEL[a.group],
      subgroup: a.subgroup,
      ...s,
      txUnitMedian: txUnit,
      txN: t?.n ?? 0,
      askToTx: s.askUnitMedian && txUnit ? Math.round((100 * s.askUnitMedian) / txUnit) / 100 : null,
    };
  });

  const notices: string[] = [];
  if (!baseline) notices.push("まだ完走したクロールがありません（LISTINGS_ENABLED・/api/listings/status を確認）");
  else if (completeRuns < 14) notices.push(`ベースライン ${baseline} 以降の完走回が ${completeRuns} 回。掲載日数・新着は数週間たまるまで参考値`);

  return {
    source: SUUMO_SOURCE_ID,
    scope,
    days,
    since,
    today,
    baseline,
    completeRuns,
    txPeriod: txQ === null ? null : { year: Math.floor(txQ / 4), quarter: (txQ % 4) + 1, quarters: 4 },
    notices,
    overall: summarize(all, completeRuns),
    areas: areaRows,
    ageBands: AGE_BANDS.map((b) => ({ id: b.id, label: b.label, ...summarize(byAge.get(b.id) ?? acc(), completeRuns) })),
    priceBands: PRICE_BANDS.map((b) => ({ id: b.id, label: b.label, ...summarize(byPrice.get(b.id) ?? acc(), completeRuns) })),
    daily: [...daily.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, v]) => ({ date, ...v })),
    runs: runsRes.results,
    allAreas: AREAS.map((a) => ({ code: a.code, name: a.name })),
  };
}

function get(m: Map<string, Acc>, k: string): Acc {
  let v = m.get(k);
  if (!v) m.set(k, (v = acc()));
  return v;
}
function get2(m: Map<string, { fresh: number; gone: number }>, k: string) {
  let v = m.get(k);
  if (!v) m.set(k, (v = { fresh: 0, gone: 0 }));
  return v;
}

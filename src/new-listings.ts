// 新築マンション（SUUMO /ms/shinchiku/・週 1 回）のビュー。/api/listings/shinchiku が返す（Access 保護下でだけ見える）。
// D1 に触る側。条件・プレミアム・並べ替えの純粋関数は src/new-listing-view.ts。

import type { Env } from "./env";
import { jstToday } from "./ingest";
import { localStateKey } from "./listing-crawl-core";
import { DEFAULT_CAT } from "./metrics";
import {
  buildUsedBaseline,
  DEFAULT_NEW_FILTERS,
  matchesNewFilters,
  newUnitPriceForPremium,
  type NewListingRow,
  parseNewFilters,
  premiumFor,
  sortNew,
} from "./new-listing-view";
import { MIN_DISTRICT_RECENT_SALES, MIN_RECENT_SALES, pickLatestQuarter, windowBounds } from "./scoring";
import { districtNameFromAddress } from "./listing-grouping";
import { SALE_STATUS_LABEL, SHINCHIKU_SOURCE_ID } from "./suumo-shinchiku";
import { AREAS, AREA_NAME, isAreaCode } from "./wards";

/** 築10年以内の中古の成約（直近 8 四半期）。プレミアムの分母 */
async function usedBaseline(env: Env) {
  const qs = await env.DB.prepare(
    `SELECT year * 4 + quarter - 1 AS qi, COUNT(DISTINCT ward_code) AS areas FROM transactions
     WHERE price_category = ? GROUP BY qi ORDER BY qi DESC LIMIT 24`,
  )
    .bind(DEFAULT_CAT)
    .all<{ qi: number; areas: number }>();
  const latestQi = pickLatestQuarter(qs.results);
  if (latestQi === null) return { baseline: buildUsedBaseline([]), latestQi: null, fromQi: null };
  const { recentFirst } = windowBounds(latestQi);
  const rows = await env.DB.prepare(
    `SELECT ward_code, district_name, unit_price FROM transactions
     WHERE price_category = ? AND (year * 4 + quarter - 1) BETWEEN ? AND ?
       AND building_year IS NOT NULL AND year - building_year BETWEEN 0 AND 10
       AND unit_price IS NOT NULL AND unit_price > 0`,
  )
    .bind(DEFAULT_CAT, recentFirst, latestQi)
    .all<{ ward_code: string; district_name: string | null; unit_price: number }>();
  return { baseline: buildUsedBaseline(rows.results), latestQi, fromQi: recentFirst };
}

async function crawlStatus(env: Env) {
  const [runs, states, lastLocal] = await Promise.all([
    env.DB.prepare(
      `SELECT run_id, crawl_date, status, started_at, finished_at, pages_fetched, listings_seen, total_hits,
         new_count, price_change_count, gone_count, note
       FROM listing_crawl_runs WHERE source = ? ORDER BY crawl_date DESC LIMIT 6`,
    )
      .bind(SHINCHIKU_SOURCE_ID)
      .all(),
    env.DB.prepare(
      "SELECT source AS fetcher, last_fetch_at, cooldown_until, last_block_kind, last_block_at FROM listing_crawl_state WHERE source IN (?, ?)",
    )
      .bind(localStateKey("shinchiku"), localStateKey("chuko"))
      .all(),
    env.DB.prepare("SELECT at, run_id, detail FROM listing_crawl_events WHERE source = ? AND kind = 'local' ORDER BY id DESC LIMIT 1")
      .bind(SHINCHIKU_SOURCE_ID)
      .first<{ at: string; run_id: string | null; detail: string | null }>(),
  ]);
  let lastLocalRun: unknown = null;
  if (lastLocal) {
    let detail: unknown = lastLocal.detail;
    try {
      detail = JSON.parse(lastLocal.detail ?? "null");
    } catch {
      /* 文字列のまま */
    }
    lastLocalRun = { at: lastLocal.at, runId: lastLocal.run_id, result: detail };
  }
  return { runs: runs.results, states: states.results, lastLocalRun };
}

function qiLabel(qi: number): string {
  return `${Math.floor(qi / 4)}Q${(qi % 4) + 1}`;
}

export async function buildNewListings(env: Env, url: URL) {
  const today = jstToday();
  const filters = parseNewFilters(url.searchParams, isAreaCode);
  const [rowsRes, histRes, used, status] = await Promise.all([
    env.DB.prepare(
      `SELECT external_id, listing_type, ward_code, building_name, address, line_name, station_name, walk_minutes, bus,
              price_min, price_max, price_undecided, price_tentative, area_min, area_max, unit_price_min, unit_price_max,
              floor_plans, sale_status, sale_label, delivery_text, delivery_ym, delivery_immediate, url,
              first_seen, last_seen, first_price_min, first_price_max, price_change_count, delisted_on
       FROM new_listings WHERE source = ?`,
    )
      .bind(SHINCHIKU_SOURCE_ID)
      .all<NewListingRow>(),
    env.DB.prepare(
      "SELECT external_id, observed_on, price_min, price_max FROM new_listing_price_history WHERE source = ? ORDER BY observed_on",
    )
      .bind(SHINCHIKU_SOURCE_ID)
      .all<{ external_id: string; observed_on: string; price_min: number | null; price_max: number | null }>(),
    usedBaseline(env),
    crawlStatus(env),
  ]);

  const history = new Map<string, { on: string; minMan: number | null; maxMan: number | null }[]>();
  const toMan = (v: number | null) => (v === null ? null : Math.round(v / 10000));
  for (const h of histRes.results) {
    const list = history.get(h.external_id) ?? history.set(h.external_id, []).get(h.external_id)!;
    list.push({ on: h.observed_on, minMan: toMan(h.price_min), maxMan: toMan(h.price_max) });
  }
  const municipalityName = (code: string) => AREA_NAME[code] ?? null;

  const all = rowsRes.results;
  const matched = all.filter((r) => matchesNewFilters(r, filters));
  const items = sortNew(
    matched.map((r) => {
      const newUnit = newUnitPriceForPremium(r);
      return {
        id: r.external_id,
        url: r.url,
        type: r.listing_type,
        buildingName: r.building_name,
        wardCode: r.ward_code,
        wardName: r.ward_code ? municipalityName(r.ward_code) : null,
        districtName: districtNameFromAddress(r.address),
        address: r.address,
        lineName: r.line_name,
        stationName: r.station_name,
        walkMinutes: r.walk_minutes,
        bus: r.bus === 1,
        priceMin: toMan(r.price_min),
        priceMax: toMan(r.price_max),
        priceUndecided: r.price_undecided === 1,
        priceTentative: r.price_tentative === 1,
        areaMin: r.area_min,
        areaMax: r.area_max,
        unitPriceMin: r.unit_price_min,
        unitPriceMax: r.unit_price_max,
        floorPlans: r.floor_plans,
        saleStatus: r.sale_status,
        saleStatusLabel: r.sale_status ? (SALE_STATUS_LABEL[r.sale_status] ?? r.sale_status) : null,
        saleLabel: r.sale_label,
        deliveryText: r.delivery_text,
        deliveryYm: r.delivery_ym,
        deliveryImmediate: r.delivery_immediate === 1,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        delistedOn: r.delisted_on,
        firstPriceMin: toMan(r.first_price_min),
        firstPriceMax: toMan(r.first_price_max),
        priceChangeCount: r.price_change_count,
        priceHistory: history.get(r.external_id) ?? [],
        premium: premiumFor(newUnit, r.ward_code, r.address, used.baseline, municipalityName),
      };
    }),
    filters.sort,
  );

  return {
    today,
    filters: {
      all: filters.all,
      pmax: filters.priceMaxMan,
      amin: filters.areaMin,
      undecided: filters.includeUndecided,
      type: filters.type,
      muni: filters.municipalities,
      ended: filters.includeEnded,
      sort: filters.sort,
    },
    defaults: DEFAULT_NEW_FILTERS,
    premiumBasis: {
      cat: DEFAULT_CAT,
      label: "成約価格",
      from: used.fromQi === null ? null : qiLabel(used.fromQi),
      to: used.latestQi === null ? null : qiLabel(used.latestQi),
      maxAgeYears: 10,
      minDistrictSales: MIN_DISTRICT_RECENT_SALES,
      minMunicipalitySales: MIN_RECENT_SALES,
    },
    allMunicipalities: AREAS.map((a) => ({ code: a.code, name: a.name, group: a.group })),
    total: all.length,
    active: all.filter((r) => r.delisted_on === null).length,
    matched: items.length,
    crawl: status,
    notes: [
      "データは SUUMO の新築マンション掲載（私的利用・週1回）。物件（分譲）単位と、同じ新築の住戸単位の掲載の両方が並びます（種別で絞れます）。",
      "販売戸数・完成時期は一覧ページに無いため取っていません（引渡時期のみ）。",
      "㎡単価は、掲載中の間取りタイプ（価格と面積の組・最大3つ）があればその範囲、無ければ 価格下限÷面積下限〜価格上限÷面積上限 の目安です。",
      "新築プレミアム = 新築の㎡単価（幅の中央。無ければ下限）÷ 同じ地区（町名）の築10年以内の中古の成約㎡単価の中央値（直近2年・国交省 不動産情報ライブラリ）− 1。地区の件数が足りなければ市区町村、それも足りなければ出しません。",
    ],
    items,
  };
}

// 「条件に合う新着・掲載中の物件」ビュー。/listings/picks・/api/listings/picks が使う（Access 保護下）。
// D1 に触る側。純粋なグルーピング・条件判定は src/listing-grouping.ts。
//
// 市区町村の売りやすさ・貸しやすさ（公開ダッシュボードと同じ src/metrics.ts の buildMetrics）と、
// 売出㎡単価/成約㎡単価の比（src/listing-metrics.ts の buildListingMetrics）をそのまま再利用する
// （scope=all・価格の種類は既定の成約価格で1回だけ計算し、市区町村コードで引く）。

import type { Env } from "./env";
import { jstToday } from "./ingest";
import {
  groupListings,
  matchesConditions,
  parsePickFilters,
  sortGroupsNewestFirst,
  type ListingPickRow,
  type PickFilters,
} from "./listing-grouping";
import { buildListingMetrics } from "./listing-metrics";
import { buildMetrics, DEFAULT_CAT } from "./metrics";
import { SUUMO_SOURCE_ID } from "./suumo";
import { AREAS, AREA_NAME, isAreaCode } from "./wards";

interface RunRow {
  run_id: string;
  crawl_date: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}
interface CursorRow {
  area_code: string;
  status: string;
}

/** 直近の完走・未完走回のカバレッジ（どの市区町村までデータが揃っているか） */
async function buildCoverage(env: Env) {
  const latest = await env.DB.prepare(
    `SELECT run_id, crawl_date, status, started_at, finished_at FROM listing_crawl_runs
     WHERE source = ? ORDER BY crawl_date DESC, started_at DESC LIMIT 1`,
  )
    .bind(SUUMO_SOURCE_ID)
    .first<RunRow>();
  const lastComplete = await env.DB.prepare(
    `SELECT run_id, crawl_date, status, started_at, finished_at FROM listing_crawl_runs
     WHERE source = ? AND status = 'complete' ORDER BY crawl_date DESC LIMIT 1`,
  )
    .bind(SUUMO_SOURCE_ID)
    .first<RunRow>();
  if (!latest) {
    return { latestRun: null, lastCompleteAt: null, areas: [] as { code: string; name: string; status: string }[] };
  }
  const cursors = await env.DB.prepare("SELECT area_code, status FROM listing_crawl_cursor WHERE run_id = ?")
    .bind(latest.run_id)
    .all<CursorRow>();
  const byCode = new Map(cursors.results.map((c) => [c.area_code, c.status]));
  const areas = AREAS.map((a) => ({ code: a.code, name: a.name, status: byCode.get(a.code) ?? "unknown" }));
  return {
    latestRun: { runId: latest.run_id, crawlDate: latest.crawl_date, status: latest.status, startedAt: latest.started_at, finishedAt: latest.finished_at },
    lastCompleteAt: lastComplete ? (lastComplete.finished_at ?? lastComplete.started_at) : null,
    areas,
  };
}

/** 市区町村ごとの売りやすさ・貸しやすさ・売出/成約比（表示範囲=すべて・価格の種類=既定の成約価格で1回だけ計算） */
async function buildAreaScores(env: Env) {
  const [metrics, listingMetrics] = await Promise.all([
    buildMetrics(env, {
      scope: "all",
      ward: null,
      age: "all",
      pmin: null,
      pmax: null,
      amin: null,
      amax: null,
      cat: DEFAULT_CAT,
      years: 10,
    }),
    buildListingMetrics(env, new URL("https://internal.invalid/api/listings/metrics?scope=all&days=90")),
  ]);
  const bySell = new Map(metrics.wardScores.map((w) => [w.ward_code, w]));
  const byAskTx = new Map(listingMetrics.areas.map((a) => [a.code, a]));
  return { bySell, byAskTx };
}

export async function buildListingPicks(env: Env, url: URL) {
  const today = jstToday();
  const nowYear = Number(today.slice(0, 4));
  const filters: PickFilters = parsePickFilters(url.searchParams, isAreaCode);

  const [rowsRes, coverage, scores] = await Promise.all([
    env.DB.prepare(
      `SELECT source, external_id, ward_code, district_name, building_name, building_year, built_month, area_sqm, floor_plan,
              line_name, station_name, walk_minutes, bus, address, url, first_seen, last_seen, current_price, first_price,
              price_cut_count, relisted_count
       FROM listings WHERE source = ? AND kind = 'sale' AND delisted_on IS NULL`,
    )
      .bind(SUUMO_SOURCE_ID)
      .all<ListingPickRow>(),
    buildCoverage(env),
    buildAreaScores(env),
  ]);

  const active = rowsRes.results.filter((r) => matchesConditions(r, filters, nowYear, today));
  const groups = sortGroupsNewestFirst(groupListings(active));

  const cards = groups.map((g) => {
    const sell = g.wardCode ? scores.bySell.get(g.wardCode) : undefined;
    const askTx = g.wardCode ? scores.byAskTx.get(g.wardCode) : undefined;
    const unitPriceMin = g.areaSqm ? Math.round(g.minPrice / g.areaSqm) : null;
    const unitPriceMax = g.areaSqm ? Math.round(g.maxPrice / g.areaSqm) : null;
    return {
      buildingName: g.buildingName,
      wardCode: g.wardCode,
      wardName: g.wardCode ? (AREA_NAME[g.wardCode] ?? null) : null,
      districtName: g.districtName,
      address: g.address,
      areaSqm: g.areaSqm,
      floorPlan: g.floorPlan,
      buildingYear: g.buildingYear,
      builtMonth: g.builtMonth,
      lineName: g.lineName,
      stationName: g.stationName,
      walkMinutes: g.walkMinutes,
      bus: g.bus,
      count: g.count,
      minPrice: g.minPrice,
      maxPrice: g.maxPrice,
      unitPriceMin,
      unitPriceMax,
      priceCutCountMax: g.priceCutCountMax,
      relistedCountMax: g.relistedCountMax,
      earliestFirstSeen: g.earliestFirstSeen,
      latestFirstSeen: g.latestFirstSeen,
      isFresh: g.latestFirstSeen >= addDays(today, -filters.freshDays),
      urls: g.urls,
      sellScore: sell?.sellScore ?? null,
      sellStatusLabel: sell?.sellStatusLabel ?? null,
      rentScore: sell?.rentScore ?? null,
      rentStatusLabel: sell?.rentStatusLabel ?? null,
      askToTx: askTx?.askToTx ?? null,
      askToTxStatus: askTx?.txStatus ?? null,
    };
  });

  return {
    today,
    filters: {
      pmax: filters.priceMaxMan,
      amin: filters.areaMin,
      plan: filters.planRoomsMin,
      dk: filters.includeDK,
      age: filters.ageMax,
      walk: filters.walkMax,
      bus: filters.includeBus,
      muni: filters.municipalities,
      fresh: filters.freshOnly,
      freshDays: filters.freshDays,
    },
    allMunicipalities: AREAS.map((a) => ({ code: a.code, name: a.name, group: a.group })),
    matchedListings: active.length,
    groups: cards.length,
    coverage,
    notes: [
      "ペット可かどうかは取得項目に無いので、リンク先で確認してください。",
      "データは SUUMO の掲載情報（私的利用）。同じ部屋が複数の仲介業者から重複掲載されることがあるため、建物名・面積・間取り・築年でまとめて1枚のカードにしています。",
    ],
    items: cards,
  };
}

function addDays(d: string, n: number): string {
  const dayMs = 86_400_000;
  const dayNum = Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
  return new Date((dayNum + n) * dayMs).toISOString().slice(0, 10);
}

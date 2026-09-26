// 「条件に合う新着・掲載中の物件」ビュー。/listings/picks・/api/listings/picks が使う（Access 保護下）。
// D1 に触る側。純粋なグルーピング・条件判定は src/listing-grouping.ts。
//
// 市区町村の売りやすさ・貸しやすさ（公開ダッシュボードと同じ src/metrics.ts の buildMetrics）と、
// 売出㎡単価/成約㎡単価の比（src/listing-metrics.ts の buildListingMetrics）をそのまま再利用する
// （scope=all・価格の種類は既定の成約価格で1回だけ計算し、市区町村コードで引く）。
//
// カードごとの価格維持（直近8四半期の㎡単価中央値 ÷ その前8四半期）も同じ buildMetrics の計算から引く
// （buildMetricsWithWindows が返す地区・市区町村の窓。カードごとに D1 へ問い合わせない）。
// SUUMO の掲載は地区名を持たないので、住所から町名を起こして（districtNameFromAddress）XIT001 の DistrictName に当てる。

import type { Env } from "./env";
import { jstToday } from "./ingest";
import {
  defaultPickFilters,
  districtNameFromAddress,
  groupListings,
  indexDistrictWindows,
  matchesConditions,
  parsePickFilters,
  parsePickKind,
  parsePickSort,
  pickRetention,
  sortPicks,
  type ListingPickRow,
  type PickFilters,
  type PickKind,
} from "./listing-grouping";
import { buildListingMetrics } from "./listing-metrics";
import { buildMetricsWithWindows, DEFAULT_CAT } from "./metrics";
import { windowBounds } from "./scoring";
import { SUUMO_SOURCE_ID } from "./suumo";
import { CHINTAI_QUERY_LABEL, CHINTAI_SOURCE_ID } from "./suumo-chintai";
import { AREAS, AREA_NAME, isAreaCode } from "./wards";

/** 画面の種類ごとの取得元（listings.source / listings.kind） */
function sourceIdFor(kind: PickKind): string {
  return kind === "rent" ? CHINTAI_SOURCE_ID : SUUMO_SOURCE_ID;
}

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
async function buildCoverage(env: Env, sourceId: string) {
  const latest = await env.DB.prepare(
    `SELECT run_id, crawl_date, status, started_at, finished_at FROM listing_crawl_runs
     WHERE source = ? ORDER BY crawl_date DESC, started_at DESC LIMIT 1`,
  )
    .bind(sourceId)
    .first<RunRow>();
  const lastComplete = await env.DB.prepare(
    `SELECT run_id, crawl_date, status, started_at, finished_at FROM listing_crawl_runs
     WHERE source = ? AND status = 'complete' ORDER BY crawl_date DESC LIMIT 1`,
  )
    .bind(sourceId)
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
  const [detailed, listingMetrics] = await Promise.all([
    buildMetricsWithWindows(env, {
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
  const bySell = new Map(detailed.metrics.wardScores.map((w) => [w.ward_code, w]));
  const byAskTx = new Map(listingMetrics.areas.map((a) => [a.code, a]));
  return {
    bySell,
    byAskTx,
    latestQi: detailed.latestQi,
    wardWindows: detailed.wardWindows,
    districtIndex: indexDistrictWindows(detailed.districtWindows),
  };
}

export async function buildListingPicks(env: Env, url: URL) {
  const today = jstToday();
  const nowYear = Number(today.slice(0, 4));
  // kind = sale（既定・中古の売り物件）| rent（賃貸。2026-09-26〜）
  const kind: PickKind = parsePickKind(url.searchParams.get("kind"));
  const sourceId = sourceIdFor(kind);
  const filters: PickFilters = parsePickFilters(url.searchParams, isAreaCode, kind);
  const sort = parsePickSort(url.searchParams);

  const [rowsRes, coverage, scores] = await Promise.all([
    env.DB.prepare(
      `SELECT source, external_id, ward_code, district_name, building_name, building_year, built_month, area_sqm, floor_plan,
              line_name, station_name, walk_minutes, bus, address, url, first_seen, last_seen, current_price, first_price,
              price_cut_count, relisted_count, admin_fee, deposit, key_money, pets_allowed, listed_on,
              building_floors, room_floor, maisonette, ldk_tatami, detail_fetched_at
       FROM listings WHERE source = ? AND kind = ? AND delisted_on IS NULL`,
    )
      .bind(sourceId, kind)
      .all<ListingPickRow>(),
    buildCoverage(env, sourceId),
    buildAreaScores(env),
  ]);

  const active = rowsRes.results.filter((r) => matchesConditions(r, filters, nowYear, today));
  const groups = groupListings(active);
  const municipalityName = (code: string) => AREA_NAME[code] ?? null;

  const unsorted = groups.map((g) => {
    const sell = g.wardCode ? scores.bySell.get(g.wardCode) : undefined;
    const askTx = g.wardCode ? scores.byAskTx.get(g.wardCode) : undefined;
    const unitPriceMin = g.areaSqm ? Math.round(g.minPrice / g.areaSqm) : null;
    const unitPriceMax = g.areaSqm ? Math.round(g.maxPrice / g.areaSqm) : null;
    // SUUMO の掲載は地区名を持たないので住所から起こす。district_name に値があっても市区町村名そのもの（「東区」）なら町名ではないので使わない
    const muniName = g.wardCode ? (AREA_NAME[g.wardCode] ?? null) : null;
    const districtName =
      districtNameFromAddress(g.address) ?? (g.districtName && g.districtName !== muniName ? g.districtName : null);
    return {
      buildingName: g.buildingName,
      wardCode: g.wardCode,
      wardName: g.wardCode ? (AREA_NAME[g.wardCode] ?? null) : null,
      districtName,
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
      // 賃貸だけ（売買では null / false）
      adminFeeMin: g.adminFeeMin,
      adminFeeMax: g.adminFeeMax,
      depositMin: g.depositMin,
      keyMoneyMin: g.keyMoneyMin,
      petsAllowed: g.petsAllowed,
      // 0007: 階数は情報として出すだけ（既定の絞り込みには使わない）。メゾネット・LDK 畳数は既定の絞り込みに使う
      buildingFloors: g.buildingFloors,
      roomFloorMin: g.roomFloorMin,
      roomFloorMax: g.roomFloorMax,
      maisonette: g.maisonette,
      ldkTatami: g.ldkTatami,
      detailFetched: g.detailFetched,
      listedOn: g.latestListedOn,
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
      /** 価格維持（成約価格）。level で地区の値か市区町村の値かを区別する。どちらも件数不足なら null */
      retention: pickRetention(g.wardCode, districtName, scores.districtIndex, scores.wardWindows, municipalityName),
    };
  });
  const cards = sortPicks(unsorted, sort);
  const wb = scores.latestQi === null ? null : windowBounds(scores.latestQi);

  return {
    today,
    kind,
    source: sourceId,
    defaults: defaultPickFilters(kind),
    filters: {
      pmax: filters.priceMaxMan,
      amin: filters.areaMin,
      plan: filters.planRoomsMin,
      dk: filters.includeDK,
      age: filters.ageMax,
      walk: filters.walkMax,
      bus: filters.includeBus,
      pets: filters.petsOnly,
      mais: filters.excludeMaisonette,
      tatami: filters.ldkTatamiMin,
      floors: filters.buildingFloorsMin,
      muni: filters.municipalities,
      fresh: filters.freshOnly,
      freshDays: filters.freshDays,
      sort,
    },
    retentionBasis: {
      cat: DEFAULT_CAT,
      label: "成約価格",
      latestQuarter: scores.latestQi === null ? null : qiLabel(scores.latestQi),
      recentFrom: wb ? qiLabel(wb.recentFirst) : null,
      priorFrom: wb ? qiLabel(wb.priorFirst) : null,
      priorTo: wb ? qiLabel(wb.recentFirst - 1) : null,
    },
    allMunicipalities: AREAS.map((a) => ({ code: a.code, name: a.name, group: a.group })),
    matchedListings: active.length,
    groups: cards.length,
    coverage,
    notes: kind === "rent" ? RENT_NOTES : SALE_NOTES,
    items: cards,
  };
}

const SALE_NOTES = [
  "ペット可かどうかは取得項目に無いので、リンク先で確認してください。",
  "データは SUUMO の掲載情報（私的利用）。同じ部屋が複数の仲介業者から重複掲載されることがあるため、建物名・面積・間取り・築年でまとめて1枚のカードにしています。",
  "価格維持 = 直近2年（8四半期）の成約㎡単価の中央値 ÷ その前2年の中央値（国交省 不動産情報ライブラリ）。1.00 より大きいほど値上がり。住所から町名を起こして地区の値を出し、地区の件数が足りない（直近8件・前期5件未満）ときは市区町村の値を出します。",
];

const RENT_NOTES = [
  "データは SUUMO の賃貸掲載（私的利用・週1回）。母数が大きいため、取得の時点で " + CHINTAI_QUERY_LABEL + " に絞っています。この範囲の外は画面の条件を広げても出てきません。",
  "ペット相談可は SUUMO の物件カードには出ないので、ペット絞り込み付きでもう一周して見えた部屋にだけ付けています。「ペット 不明」はペット不可という意味ではありません（その回に拾えなかっただけのことがあります）。条件（敷金の増額・種類・頭数）はリンク先で必ず確認してください。",
  "メゾネット（室内が2層の住戸）は既定で除いています。SUUMO の物件カードにメゾネットの表記が無いので、メゾネット絞り込み（/nj_113/）付きでもう一周して見えた部屋と、一覧の階が「1-2階」のように2フロアにまたがる部屋に印を付けています。「メゾネット 不明」はワンフロアだと確かめたという意味ではありません。",
  "LDK の畳数は SUUMO の一覧に出ないので、ここまでの条件を全部通った部屋だけ詳細ページを取って読んでいます（1回の実行で60件まで・60秒間隔）。「LDK畳数 未取得」はまだ詳細ページを取っていないだけで、15畳未満という意味ではありません（既定の絞り込みでも落としていません）。",
  "建物の階数・部屋の階は情報として出しているだけで、既定の絞り込みには使っていません（2階建ての建物も出ます）。URL に floors=3 を足すと「3階建て以上」で絞れます。",
  "SUUMO の賃貸一覧には掲載日・情報公開日がありません。出しているのは「このウォッチが最初に見た日」です（掲載日数・値下げの追跡は売買だけ）。",
  "管理費・敷金・礼金が「—」の物件は、SUUMO の表記が「-」で、0 円なのか表記なしなのか一覧からは分かりません（0 円と決めつけていません）。",
  "同じ建物・同じ間取り・同じ築年で専有面積が近い部屋は 1 枚のカードにまとめています（複数業者の重複掲載をまとめる売買と同じ仕組み）。別の部屋がまとまることもあるので、部屋の特定はリンク先で。",
  "価格維持・売出/成約比は売買の指標なので賃貸では出していません（貸しやすさは市区町村単位の目安です）。",
];

/** 四半期の通し番号（year*4 + quarter - 1）→ "2026Q2" */
function qiLabel(qi: number): string {
  return `${Math.floor(qi / 4)}Q${(qi % 4) + 1}`;
}

function addDays(d: string, n: number): string {
  const dayMs = 86_400_000;
  const dayNum = Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
  return new Date((dayNum + n) * dayMs).toISOString().slice(0, 10);
}

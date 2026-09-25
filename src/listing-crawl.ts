// 掲載情報（SUUMO）の日次クロールの D1 側。取得する場所は LISTINGS_ENABLED で 2 通り:
//   - "external"（2026-09-22〜 本番）… Mac（launchd・scripts/suumo-crawl-local.ts）が取ってきた 1 ページぶんの結果を
//     POST /api/ingest/listings（handleListingIngest）で受け、下の applyOutcome で反映する。cron は取りに行かない
//   - "on" … Worker の cron（runListingCrawl）が自分で取る。2026-09-14 に 43 ページ目で 503、9/17・9/20 は 1 ページ目で 503
//     （Cloudflare Workers の送信元が弾かれている様子。同じ URL を自宅回線から curl すると 200）ため external に移した
//   - "off"（既定）… どちらも動かない。cron は D1 にも触らず即 return、取り込みは 409
// どちらの経路でも「ページの反映とカーソル前進を同じトランザクションで」「完走回だけ掲載終了」「85% ルール」は同じ関数を通る。
// クールダウン・最終取得時刻（listing_crawl_state）は取得元ごとに持つ（Worker = SUUMO_SOURCE_ID、Mac = localStateKey(kind)）。
// 送信元 IP が違うので、Worker の IP が受けたクールダウンで Mac を止めない（逆も同じ）。
//
// 種類（kind）: 中古（chuko・毎日・listings.kind='sale'）・新築（shinchiku・週 1 回・new_listings。2026-09-22〜）・
// 賃貸（chintai・週 1 回・listings.kind='rent'。2026-09-26〜）。取得元ごとに許す kind は CRAWL_KINDS.listingKind が正。
// クロールの状態の表（runs・cursor・state・events・snapshots）は取得元 ID（suumo:ms-chuko / suumo:ms-shinchiku）で分かれるので共用し、
// 掲載を入れる表と 1 ページの反映文だけを ListingStore で差し替える（カーソル・止まり方・掲載終了の判定は 1 つの実装）。
// Mac の取得元は中古・新築で別キー（suumo:ms-chuko@mac / suumo:ms-shinchiku@mac）だが、送信元 IP は同じ Mac なので
//   - クールダウンは「Mac のどちらかのキーがクールダウン中なら、どちらも取らない」
//   - ページ間隔の起点は「Mac のどちらかのキーで最後に取った時刻」
// にしている（同じ相手に別の種類として続けて取りに行かない）。
//
// 以下は Worker cron 方式（on）の設計メモ（Workers Paid 前提。2026-09 確認: Cron の CPU 30s（1 時間未満間隔）/ 実行時間 15 分 / サブリクエスト 10,000）
//   - 1 日ぶん ≒ 福岡市 180 ページ + 近郊 51 ページ ≒ 231 ページ（2026-09-14 の件数から）
//   - 1 ページごとに 60 秒あける（下限 60 秒。state.last_fetch_at で起動をまたいでも守る）
//     2026-09-14 の初回は 6 秒間隔で 43 ページ目に Cloudflare から 503 を返されたため、時間をかけてでも間隔を広げた
//     → 1 ページ ≒ 61 秒 → 231 ページ ≒ 4 時間
//   - cron `*/15 16-20 * * *`（01:00〜05:45 JST・20 起動）で分割。1 起動は 10 分で自主的に切り上げ（15 分上限まで 5 分の余裕）。
//     1 起動 ≒ 19 ページなので 13 起動ほどで終わり、残りは失敗時の再開の余裕。取り切った後の起動は数クエリで終わる
//   - 進み具合は D1（listing_crawl_cursor）に 1 ページごとに保存 → どこで落ちても次の起動が続きから
//   - D1 は 1 起動あたり 1,000 クエリ（Paid。batch 内の各文も 1 クエリ）。1 ページ ≒ 7〜8 クエリ
//     （カーソル取得 1・取得前の記録 2・既存価格 1・反映 3〜4。止まった／失敗したページは 3〜4）
//     × 上限 100 ページ + 起動前後 ≒ 20 → 最大 ≒ 820 に収める
//   - 403 / 429 / 503 / captcha らしき応答 / 一覧の構造が無い → その日は打ち切り、72 時間クールダウンして記録
//   - 「掲載終了」は全市区町村を取り切った回（complete）でだけ付ける。途中で止まった回・件数が合わない回では付けない
//
// Free プランで何が壊れるか（README にも記載）:
//   - CPU 10ms/起動: 230KB の HTML を 1〜数ページ解析した時点で超える → Exceeded CPU で落ちる
//   - サブリクエスト 50/起動・D1 クエリ 50/起動: 1 起動 7 ページ前後で上限
//   → 231 ページを 30 秒間隔で取るには 1 日 100 起動以上が要り、cron の起動回数・取得時刻の幅も現実的でない

import type { Env } from "./env";
import { jstToday } from "./ingest";
import { checkIngestToken } from "./ingest-auth";
import {
  type AnyListingRecord,
  CRAWL,
  CRAWL_KINDS,
  type CrawlKind,
  crawlSettings,
  fetchAndClassify,
  type IngestCursor,
  type IngestResponse,
  listingsMode,
  localOrigin,
  localStateKey,
  outcomeMessage,
  type PageOutcome,
  parseIngestRequest,
} from "./listing-crawl-core";
import type { CrawlTarget, ListingRecord, NewListingRecord, PagedSource, ParsedListPage } from "./listing-types";
import { SUUMO_SOURCE_ID } from "./suumo";
import { ChintaiSource } from "./suumo-chintai";
import { ShinchikuSource } from "./suumo-shinchiku";
import { SuumoSource } from "./suumo-source";

/** wrangler.toml の crons と一致させること（scheduled のディスパッチに使う） */
export const LISTINGS_CRON = "*/15 16-20 * * *";

// 設定・応答の振り分け・取り込み要求の検証は Node（Mac 側）と共有するため src/listing-crawl-core.ts に置いた
export { CRAWL, crawlSettings, listingsMode, localOrigin } from "./listing-crawl-core";
export type { CrawlSettings, ListingsMode } from "./listing-crawl-core";

/** Worker の cron が SUUMO を取りに行くか（LISTINGS_ENABLED=on のときだけ）。external・off では取らない */
export function listingsEnabled(env: Pick<Env, "LISTINGS_ENABLED">): boolean {
  return listingsMode(env) === "on";
}

/** Mac 側の取得の状態（クールダウン・最終取得時刻）の置き場（中古）。Worker cron の状態（SUUMO_SOURCE_ID）とは別 */
export const LOCAL_STATE_KEY = localStateKey("chuko");
/** Mac 側の全キー（中古・新築）。送信元が同じ Mac なので、クールダウンと間隔の起点はまとめて見る */
const ALL_LOCAL_STATE_KEYS = (Object.keys(CRAWL_KINDS) as CrawlKind[]).map(localStateKey);

export interface CrawlDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: CrawlDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export interface CrawlSummary {
  status: "disabled" | "cooldown" | "locked" | "running" | "complete" | "incomplete" | "blocked" | "error";
  runId?: string;
  pages: number;
  detail?: string;
}

/**
 * cron が実際に起動したことを残す（/api/listings/status の lastCronRun）。scheduled の振り分けは
 * controller.cron と LISTINGS_CRON の文字列一致なので、ずれて一度も起動していないことに気づけるようにする。
 * on のときだけ呼ぶ（off なら D1 に触らない）。記録の失敗はクロール結果に影響させない。
 */
export async function recordCronInvocation(env: Env, cron: string, startedAt: string, r: CrawlSummary): Promise<void> {
  try {
    await event(
      env.DB,
      SUUMO_SOURCE_ID,
      r.runId ?? null,
      "cron",
      null,
      null,
      JSON.stringify({ cron, startedAt, status: r.status, pages: r.pages, detail: r.detail }),
      new Date().toISOString(),
    ).run();
  } catch (e) {
    console.error("cron 起動の記録に失敗", e);
  }
}

interface CursorRow {
  area_code: string;
  slug: string;
  next_page: number;
  total_pages: number | null;
  total_hits: number | null;
  attempts: number;
}

interface OpenedRun {
  status: CrawlSummary["status"];
  runId: string;
  lastFetchAt: string | null;
  detail?: string;
}

/**
 * 今日（date）の回を開く（無ければ回とカーソルを作る）。stateKey の取得元がクールダウン中・回が完了済み・
 * 他が実行中なら running 以外を返す。running のときは lease を取った状態で返す（呼んだ側が releaseLease する）。
 */
async function openRun(
  db: D1Database,
  source: PagedSource<unknown>,
  stateKey: string,
  date: string,
  now: () => number,
  leaseMs: number,
  /** クールダウンと最終取得時刻を一緒に見るキー（同じ送信元の別の種類。Mac なら ALL_LOCAL_STATE_KEYS） */
  sharedKeys: readonly string[] = [stateKey],
): Promise<OpenedRun> {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const startedMs = now();
  const runId = `${source.id}:${date}`;
  const keys = [...new Set([stateKey, ...sharedKeys])];

  await db.prepare("INSERT OR IGNORE INTO listing_crawl_state (source) VALUES (?)").bind(stateKey).run();
  const state = await db
    .prepare(
      `SELECT MAX(last_fetch_at) AS last_fetch_at, MAX(cooldown_until) AS cooldown_until
       FROM listing_crawl_state WHERE source IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(keys))
    .first<{ last_fetch_at: string | null; cooldown_until: string | null }>();
  const lastFetchAt = state?.last_fetch_at ?? null;
  if (state?.cooldown_until && state.cooldown_until > iso()) {
    console.log(`掲載クロール（${stateKey}）はクールダウン中（${state.cooldown_until} まで・${keys.join(", ")} のいずれか）`);
    return { status: "cooldown", runId, lastFetchAt, detail: state.cooldown_until };
  }

  // 前日以前の走りかけの回は未完了として閉じる（掲載終了は付けない）
  await db
    .prepare(
      `UPDATE listing_crawl_runs SET status = 'incomplete', finished_at = ?, lease_until = NULL,
         note = COALESCE(note || ' / ', '') || '日付が変わるまでに取り切れなかった'
       WHERE source = ? AND status = 'running' AND crawl_date < ?`,
    )
    .bind(iso(), source.id, date)
    .run();

  const targets = source.targets();
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO listing_crawl_runs (run_id, source, crawl_date, status, started_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .bind(runId, source.id, date, iso(), iso()),
    db
      .prepare(
        `INSERT OR IGNORE INTO listing_crawl_cursor (run_id, area_code, slug, sort_order, updated_at)
         SELECT ?1, json_extract(j.value, '$.code'), json_extract(j.value, '$.slug'), j.key, ?2 FROM json_each(?3) AS j`,
      )
      .bind(runId, iso(), JSON.stringify(targets.map((t) => ({ code: t.areaCode, slug: t.key })))),
  ]);

  const run = await db
    .prepare("SELECT status FROM listing_crawl_runs WHERE run_id = ?")
    .bind(runId)
    .first<{ status: CrawlSummary["status"] }>();
  if (!run || run.status !== "running") return { status: run?.status ?? "incomplete", runId, lastFetchAt };

  const lease = await db
    .prepare(
      `UPDATE listing_crawl_runs SET lease_until = ?, invocations = invocations + 1, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(iso(startedMs + leaseMs), iso(), runId, iso())
    .run();
  if (!lease.meta.changes) return { status: "locked", runId, lastFetchAt };
  return { status: "running", runId, lastFetchAt };
}

/** 次に取るページ（試行回数の少ない順・市区町村の並び順） */
async function nextCursor(db: D1Database, runId: string): Promise<CursorRow | null> {
  return db
    .prepare(
      `SELECT area_code, slug, next_page, total_pages, total_hits, attempts FROM listing_crawl_cursor
       WHERE run_id = ? AND status = 'pending' ORDER BY attempts, sort_order LIMIT 1`,
    )
    .bind(runId)
    .first<CursorRow>();
}

/** 1 リクエストを記録する（0 件ページ・404・失敗も「1 リクエスト」として数え、間隔の起点にする） */
async function recordFetch(db: D1Database, stateKey: string, runId: string, at: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE listing_crawl_state SET last_fetch_at = ? WHERE source = ?").bind(at, stateKey),
    db.prepare("UPDATE listing_crawl_runs SET pages_fetched = pages_fetched + 1 WHERE run_id = ?").bind(runId),
  ]);
}

async function releaseLease(db: D1Database, runId: string): Promise<void> {
  await db.prepare("UPDATE listing_crawl_runs SET lease_until = NULL WHERE run_id = ? AND status = 'running'").bind(runId).run();
}

/**
 * 1 ページぶんの結果を D1 に反映する（Worker cron と Mac からの取り込みで共通）。
 * blocked なら stateKey の取得元を 72 時間クールダウンにして、その回を blocked で閉じる。
 */
async function applyOutcome<R>(
  db: D1Database,
  source: PagedSource<R>,
  store: ListingStore<R>,
  stateKey: string,
  runId: string,
  date: string,
  cur: CursorRow,
  outcome: PageOutcome<R>,
  url: string,
  now: () => number,
): Promise<{ blocked?: string }> {
  const iso = (ms = now()) => new Date(ms).toISOString();
  switch (outcome.kind) {
    case "fetch_error":
    case "http_error":
      await cursorError(db, runId, source.id, cur, url, outcomeMessage(outcome), iso());
      return {};
    case "gone":
      // 取っている間に件数が減って、最後のページが無くなった
      await cursorDone(db, runId, cur, cur.total_pages, cur.total_hits, 0, iso());
      return {};
    case "parsed":
      await applyPage(db, source, store, runId, date, cur, outcome.page, url, iso());
      return {};
    case "blocked": {
      const { block, status, location, bodyHead } = outcome;
      const until = iso(now() + CRAWL.cooldownHours * 3600_000);
      await db.batch([
        db
          .prepare("UPDATE listing_crawl_state SET cooldown_until = ?, last_block_kind = ?, last_block_at = ? WHERE source = ?")
          .bind(until, block, iso(), stateKey),
        db
          .prepare(
            `UPDATE listing_crawl_runs SET status = 'blocked', finished_at = ?, lease_until = NULL, updated_at = ?,
               note = COALESCE(note || ' / ', '') || ? WHERE run_id = ?`,
          )
          .bind(iso(), iso(), `${block} で停止（${stateKey}・${until} までクールダウン）`, runId),
        event(
          db,
          source.id,
          runId,
          "blocked",
          status,
          url,
          `${block}; via=${stateKey}; cooldown_until=${until}${location ? `; location=${location.slice(0, 300)}` : ""}; body_head=${bodyHead.slice(0, 200)}`,
          iso(),
        ),
      ]);
      console.warn(`掲載クロール停止: ${block} ${status} ${url}（${stateKey}）`);
      return { blocked: block };
    }
  }
}

/** 残りのページが無ければ回を締める（complete のときだけ掲載終了を付ける）。残っていれば running */
async function closeIfDone(
  db: D1Database,
  store: StoreInfo,
  runId: string,
  date: string,
  at: string,
): Promise<{ status: CrawlSummary["status"]; detail?: string }> {
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM listing_crawl_cursor WHERE run_id = ? AND status = 'pending'")
    .bind(runId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) return { status: "running" };
  const r = await finalizeRun(db, store, runId, date, at);
  return { status: r.status, detail: r.detail };
}

/** Worker の cron が自分で取る（LISTINGS_ENABLED=on のときだけ）。1 起動は 10 分で切り上げ、続きは次の起動 */
export async function runListingCrawl(env: Env, deps: CrawlDeps = defaultDeps): Promise<CrawlSummary> {
  if (!listingsEnabled(env)) {
    console.log("LISTINGS_ENABLED が on ではないため Worker の掲載クロールはスキップ");
    return { status: "disabled", pages: 0 };
  }
  const s = crawlSettings(env);
  const source = new SuumoSource({ origin: s.origin, userAgent: s.userAgent, minIntervalMs: s.intervalMs });
  const db = env.DB;
  const startedMs = deps.now();
  const iso = (ms = deps.now()) => new Date(ms).toISOString();
  const date = s.todayOverride ?? jstToday(new Date(startedMs));

  const opened = await openRun(db, source, source.id, date, deps.now, CRAWL.leaseMs);
  const runId = opened.runId;
  if (opened.status !== "running") return { status: opened.status, runId, pages: 0, detail: opened.detail };

  let lastFetch = opened.lastFetchAt ? Date.parse(opened.lastFetchAt) : 0;
  let pages = 0;
  try {
    for (;;) {
      const cur = await nextCursor(db, runId);
      if (!cur) break;
      if (pages >= s.maxPages) break;
      const wait = Math.max(0, lastFetch + s.intervalMs - deps.now());
      if (deps.now() - startedMs + wait + CRAWL.fetchTimeoutMs > s.budgetMs) break;
      if (wait > 0) await deps.sleep(wait);

      const target: CrawlTarget = { areaCode: cur.area_code, key: cur.slug };
      const url = source.pageUrl(target, cur.next_page);
      lastFetch = deps.now();
      // 取りに行く前に記録する
      await recordFetch(db, source.id, runId, iso(lastFetch));
      pages++;

      const outcome = await fetchAndClassify(deps.fetch, source, target, cur.next_page, url);
      const r = await applyOutcome(db, source, CHUKO_STORE, source.id, runId, date, cur, outcome, url, deps.now);
      if (r.blocked) return { status: "blocked", runId, pages, detail: r.blocked };
    }
    return { ...(await closeIfDone(db, CHUKO_STORE, runId, date, iso())), runId, pages };
  } finally {
    await releaseLease(db, runId);
    console.log(JSON.stringify({ listingCrawl: { runId, pages } }));
  }
}

// ---------------------------------------------------------------------------
// Mac（launchd）からの取り込み: POST /api/ingest/listings（LISTINGS_ENABLED=external のときだけ）
//   Authorization: Bearer <LISTINGS_INGEST_TOKEN>（src/ingest-auth.ts・未設定なら全員 401）
//   {op:"begin"} → 今日の回を開き、次に取るページを返す
//   {op:"page", runId, areaCode, page, url, fetchedAt, outcome} → 1 ページ反映して次を返す
//     送られた (areaCode, page) がカーソルの位置と違えば反映せず stale:true で今の位置を返す（再送しても二重計上しない）
//   {op:"end", runId, summary} → lease を返し、kind='local' のイベントに結果を残す（/api/listings/status の lastLocalRun）
// 1 リクエスト = 1 起動なので D1 クエリは 1 ページ ≒ 10 本で済む（上限 1,000）。
// ---------------------------------------------------------------------------

/** Mac 側クローラの取り込み口（POST・Bearer 認証）。src/index.ts が Access の判定より先に振り分ける */
export const INGEST_PATH = "/api/ingest/listings";

const MAX_INGEST_BODY = 512 * 1024;

const ingestJson = (body: IngestResponse, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra },
  });

async function cursorView(db: D1Database, runId: string): Promise<IngestCursor | null> {
  const c = await nextCursor(db, runId);
  return c ? { areaCode: c.area_code, slug: c.slug, page: c.next_page } : null;
}

/**
 * 次に取るページを返す。残りが無ければ締める。
 * extendLease: 実際にページを反映したときだけ lease を延ばす（再送・begin では延ばさない。
 * 終わった実行の再送で lease が張り直され、次の実行が待たされるのを防ぐ）
 */
async function afterIngestStep(
  db: D1Database,
  store: StoreInfo,
  runId: string,
  date: string,
  now: () => number,
  extendLease: boolean,
): Promise<IngestResponse> {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const next = await cursorView(db, runId);
  if (next) {
    if (extendLease) {
      await db
        .prepare("UPDATE listing_crawl_runs SET lease_until = ?, updated_at = ? WHERE run_id = ? AND status = 'running'")
        .bind(iso(now() + CRAWL.ingestLeaseMs), iso(), runId)
        .run();
    }
    return { ok: true, status: "running", runId, next };
  }
  const done = await closeIfDone(db, store, runId, date, iso());
  if (done.status !== "running") await releaseLease(db, runId);
  return { ok: true, status: done.status, runId, next: null, detail: done.detail };
}

export async function handleListingIngest(req: Request, env: Env, now: () => number = () => Date.now()): Promise<Response> {
  if (req.method !== "POST") return ingestJson({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST" });
  // 認証を最初に（未認証の相手にはモードも何も教えない）
  if (!(await checkIngestToken(req.headers.get("authorization"), env.LISTINGS_INGEST_TOKEN))) {
    return ingestJson({ ok: false, error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  if (listingsMode(env) !== "external") {
    return ingestJson({ ok: false, error: "LISTINGS_ENABLED が external ではないため取り込まない" }, 409);
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_INGEST_BODY) return ingestJson({ ok: false, error: "too_large" }, 413);
  const text = await req.text();
  if (text.length > MAX_INGEST_BODY) return ingestJson({ ok: false, error: "too_large" }, 413);
  let r;
  try {
    r = parseIngestRequest(JSON.parse(text));
  } catch (e) {
    return ingestJson({ ok: false, error: `bad_request: ${e instanceof Error ? e.message : "JSON が不正"}` }, 400);
  }

  const db = env.DB;
  // kind ごとに情報源（ページサイズ・対象）と掲載の表を切り替える。どちらも Worker では解析しない（Mac が送った結果を反映するだけ）
  if (r.kind === "shinchiku") return ingestKind(db, env, r, new ShinchikuSource(), SHINCHIKU_STORE, now);
  if (r.kind === "chintai") return ingestKind(db, env, r, new ChintaiSource(), CHINTAI_STORE, now);
  return ingestKind(db, env, r, new SuumoSource(), CHUKO_STORE, now);
}

async function ingestKind<R extends AnyListingRecord>(
  db: D1Database,
  env: Env,
  r: ReturnType<typeof parseIngestRequest>,
  source: PagedSource<R>,
  store: ListingStore<R>,
  now: () => number,
): Promise<Response> {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const stateKey = localStateKey(r.kind);

  if (r.op === "begin") {
    const date = crawlSettings(env).todayOverride ?? jstToday(new Date(now()));
    const o = await openRun(db, source, stateKey, date, now, CRAWL.ingestLeaseMs, ALL_LOCAL_STATE_KEYS);
    if (o.status !== "running") {
      return ingestJson({ ok: true, status: o.status, runId: o.runId, next: null, lastFetchAt: o.lastFetchAt, detail: o.detail });
    }
    // lease は openRun が取った
    const step = await afterIngestStep(db, store, o.runId, date, now, false);
    return ingestJson({ ...step, lastFetchAt: o.lastFetchAt });
  }

  const run = await db
    .prepare("SELECT crawl_date, status FROM listing_crawl_runs WHERE run_id = ? AND source = ?")
    .bind(r.runId, source.id)
    .first<{ crawl_date: string; status: string }>();

  if (r.op === "end") {
    // クールダウン中は回そのものが作られていないので、回が無くても実行の記録は残す
    if (run) await releaseLease(db, r.runId);
    await event(db, source.id, r.runId, "local", null, null, JSON.stringify({ ...r.summary, runStatus: run?.status ?? null }), iso()).run();
    return ingestJson({ ok: true, status: run?.status ?? r.summary.status, runId: r.runId, next: null });
  }

  // op === "page"
  if (!run) return ingestJson({ ok: false, error: "unknown_run" }, 404);
  if (run.status !== "running") return ingestJson({ ok: true, status: run.status, runId: r.runId, next: null });
  const cur = await db
    .prepare(
      `SELECT area_code, slug, next_page, total_pages, total_hits, attempts, status FROM listing_crawl_cursor
       WHERE run_id = ? AND area_code = ?`,
    )
    .bind(r.runId, r.areaCode)
    .first<CursorRow & { status: string }>();
  if (!cur || cur.status !== "pending" || cur.next_page !== r.page) {
    const step = await afterIngestStep(db, store, r.runId, run.crawl_date, now, false);
    return ingestJson({ ...step, stale: true });
  }
  // 取った時刻は Mac の申告（未来・15 分より昔は丸める）。次の間隔の起点になる
  const fetchedMs = Math.min(now(), Math.max(now() - 15 * 60_000, Date.parse(r.fetchedAt)));
  await recordFetch(db, stateKey, r.runId, iso(fetchedMs));
  // parseIngestRequest が kind に合わせて records を検証済み（chuko = ListingRecord・shinchiku = NewListingRecord）
  const outcome = r.outcome as PageOutcome<R>;
  const res = await applyOutcome(db, source, store, stateKey, r.runId, run.crawl_date, cur, outcome, r.url, now);
  if (res.blocked) return ingestJson({ ok: true, status: "blocked", runId: r.runId, next: null, detail: res.blocked });
  return ingestJson(await afterIngestStep(db, store, r.runId, run.crawl_date, now, true));
}

function event(
  db: D1Database,
  source: string,
  runId: string | null,
  kind: string,
  httpStatus: number | null,
  url: string | null,
  detail: string | null,
  at: string,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO listing_crawl_events (source, run_id, at, kind, http_status, url, detail) VALUES (?,?,?,?,?,?,?)")
    .bind(source, runId, at, kind, httpStatus, url, detail ? detail.slice(0, 1000) : null);
}

async function cursorError(
  db: D1Database,
  runId: string,
  source: string,
  cur: CursorRow,
  url: string,
  msg: string,
  at: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE listing_crawl_cursor SET attempts = attempts + 1, last_error = ?, updated_at = ?,
           status = CASE WHEN attempts + 1 >= ? THEN 'error' ELSE 'pending' END
         WHERE run_id = ? AND area_code = ?`,
      )
      .bind(msg.slice(0, 500), at, CRAWL.maxAttempts, runId, cur.area_code),
    event(db, source, runId, "error", null, url, msg, at),
  ]);
}

async function cursorDone(
  db: D1Database,
  runId: string,
  cur: CursorRow,
  totalPages: number | null,
  totalHits: number | null,
  seen: number,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE listing_crawl_cursor SET status = 'done', total_pages = ?, total_hits = ?, seen = seen + ?, attempts = 0,
         last_error = NULL, updated_at = ? WHERE run_id = ? AND area_code = ?`,
    )
    .bind(totalPages, totalHits, seen, at, runId, cur.area_code)
    .run();
}

/**
 * listings への 1 ページぶんの upsert。中古（kind='sale'）と賃貸（kind='rent'）で共通。
 * ?5 = listings.kind（取得元ごとに CRAWL_KINDS.listingKind で決まる。外からの値は入らない）。
 * 賃貸だけの列（admin_fee・deposit・key_money・pets_allowed・listed_on）は sale では常に NULL / 0 になる
 * （JSON に鍵が無ければ json_extract は NULL。pets は 0 を入れて渡す）。
 */
const UPSERT_LISTINGS = `
INSERT INTO listings (source, external_id, kind, ward_code, building_name, building_year, built_month, area_sqm, floor_plan,
  line_name, station_name, walk_minutes, bus, address, url, first_seen, last_seen, current_price, first_price,
  price_cut_count, relisted_count, missed_runs, delisted_on, last_seen_run,
  admin_fee, deposit, key_money, pets_allowed, listed_on)
SELECT ?1, json_extract(j.value, '$.id'), ?5, json_extract(j.value, '$.ward'), json_extract(j.value, '$.name'),
  json_extract(j.value, '$.by'), json_extract(j.value, '$.bm'), json_extract(j.value, '$.area'), json_extract(j.value, '$.plan'),
  json_extract(j.value, '$.line'), json_extract(j.value, '$.st'), json_extract(j.value, '$.walk'), json_extract(j.value, '$.bus'),
  json_extract(j.value, '$.addr'), json_extract(j.value, '$.url'), ?2, ?2, json_extract(j.value, '$.price'),
  json_extract(j.value, '$.price'), 0, 0, 0, NULL, ?3,
  json_extract(j.value, '$.fee'), json_extract(j.value, '$.dep'), json_extract(j.value, '$.key'),
  COALESCE(json_extract(j.value, '$.pets'), 0), json_extract(j.value, '$.listed')
FROM json_each(?4) AS j WHERE true
ON CONFLICT (source, external_id) DO UPDATE SET
  ward_code = excluded.ward_code, building_name = excluded.building_name, building_year = excluded.building_year,
  built_month = excluded.built_month, area_sqm = excluded.area_sqm, floor_plan = excluded.floor_plan,
  line_name = excluded.line_name, station_name = excluded.station_name, walk_minutes = excluded.walk_minutes,
  bus = excluded.bus, address = excluded.address, url = excluded.url,
  admin_fee = excluded.admin_fee, deposit = excluded.deposit, key_money = excluded.key_money,
  pets_allowed = excluded.pets_allowed, listed_on = COALESCE(excluded.listed_on, listings.listed_on),
  last_seen = excluded.last_seen,
  price_cut_count = listings.price_cut_count + (CASE WHEN excluded.current_price < listings.current_price THEN 1 ELSE 0 END),
  current_price = excluded.current_price,
  relisted_count = listings.relisted_count + (CASE WHEN listings.delisted_on IS NOT NULL THEN 1 ELSE 0 END),
  delisted_on = NULL, missed_runs = 0, last_seen_run = excluded.last_seen_run`;

const INSERT_HISTORY = `
INSERT INTO listing_price_history (source, external_id, observed_on, price)
SELECT ?1, json_extract(j.value, '$.id'), ?2, json_extract(j.value, '$.price') FROM json_each(?3) AS j WHERE true
ON CONFLICT (source, external_id, observed_on) DO UPDATE SET price = excluded.price`;

/** 掲載を入れる表の情報（掲載終了の判定・件数に使う）。表名は定数だけ（SQL に埋め込むため外からの値を入れない） */
interface StoreInfo {
  readonly sourceId: string;
  readonly table: "listings" | "new_listings";
}

/** 種類ごとの掲載の表。1 ページぶんの反映文（履歴 → upsert）を作る。カーソル・回の更新は applyPage が足して同じ batch にする */
interface ListingStore<R> extends StoreInfo {
  pageStatements(
    db: D1Database,
    runId: string,
    date: string,
    areaCode: string,
    records: R[],
  ): Promise<{ stmts: D1PreparedStatement[]; newCount: number; changedCount: number; rows: number }>;
}

/**
 * listings 表を使う取得元（中古 = sale・賃貸 = rent）のストアを作る。
 * listingKind は CRAWL_KINDS の定数だけ（外からの値は入れない）。反映の仕方は中古・賃貸で同じ。
 */
function listingsStore(sourceId: string, listingKind: "sale" | "rent"): ListingStore<ListingRecord> {
  return {
  sourceId,
  table: "listings",
  async pageStatements(db, runId, date, areaCode, records) {
    const byId = new Map(records.map((r) => [r.externalId, r]));
    const ids = [...byId.keys()];
    const prev = await db
      .prepare(
        "SELECT external_id, current_price FROM listings WHERE source = ?1 AND external_id IN (SELECT value FROM json_each(?2))",
      )
      .bind(this.sourceId, JSON.stringify(ids))
      .all<{ external_id: string; current_price: number | null }>();
    const prevPrice = new Map(prev.results.map((r) => [r.external_id, r.current_price]));
    let newCount = 0;
    let changedCount = 0;
    const history: { id: string; price: number }[] = [];
    for (const r of byId.values()) {
      if (!prevPrice.has(r.externalId)) {
        newCount++;
        history.push({ id: r.externalId, price: r.price });
      } else if (prevPrice.get(r.externalId) !== r.price) {
        changedCount++;
        history.push({ id: r.externalId, price: r.price });
      }
    }
    const rows = [...byId.values()].map((r) => ({
      id: r.externalId,
      ward: r.wardCode ?? areaCode,
      name: r.buildingName ?? null,
      by: r.buildingYear ?? null,
      bm: r.builtMonth ?? null,
      area: r.areaSqm ?? null,
      plan: r.floorPlan ?? null,
      line: r.lineName ?? null,
      st: r.stationName ?? null,
      walk: r.walkMinutes ?? null,
      bus: r.bus ? 1 : 0,
      addr: r.address ?? null,
      url: r.url ?? null,
      price: r.price,
      // 賃貸だけの項目（売買では undefined → JSON に入らない → json_extract は NULL）
      fee: r.adminFee ?? null,
      dep: r.deposit ?? null,
      key: r.keyMoney ?? null,
      pets: r.petsAllowed ? 1 : 0,
      listed: r.listedOn ?? null,
    }));
    const stmts: D1PreparedStatement[] = [];
    // 履歴は listings を更新する前に（新規・価格変更の判定は上の prev で済ませてある）
    if (history.length) stmts.push(db.prepare(INSERT_HISTORY).bind(this.sourceId, date, JSON.stringify(history)));
    stmts.push(db.prepare(UPSERT_LISTINGS).bind(this.sourceId, date, runId, JSON.stringify(rows), listingKind));
    return { stmts, newCount, changedCount, rows: rows.length };
  },
  };
}

/** 中古（listings.kind = 'sale'・0001/0003） */
const CHUKO_STORE = listingsStore(SUUMO_SOURCE_ID, "sale");
/** 賃貸（listings.kind = 'rent'・0006） */
const CHINTAI_STORE = listingsStore(CRAWL_KINDS.chintai.sourceId, "rent");

// ---- 新築（new_listings・0005）。価格は幅（円）・未定は NULL。価格変化 = 下限か上限が変わった（未定→決定も含む）
const UPSERT_NEW_LISTINGS = `
INSERT INTO new_listings (source, external_id, listing_type, ward_code, building_name, address, line_name, station_name,
  walk_minutes, bus, price_min, price_max, price_undecided, price_tentative, area_min, area_max, unit_price_min, unit_price_max,
  floor_plans, sale_status, sale_label, delivery_text, delivery_ym, delivery_immediate, url,
  first_seen, last_seen, first_price_min, first_price_max, price_change_count, relisted_count, missed_runs, delisted_on, last_seen_run)
SELECT ?1, json_extract(j.value, '$.id'), json_extract(j.value, '$.type'), json_extract(j.value, '$.ward'),
  json_extract(j.value, '$.name'), json_extract(j.value, '$.addr'), json_extract(j.value, '$.line'), json_extract(j.value, '$.st'),
  json_extract(j.value, '$.walk'), json_extract(j.value, '$.bus'), json_extract(j.value, '$.pmin'), json_extract(j.value, '$.pmax'),
  json_extract(j.value, '$.pund'), json_extract(j.value, '$.ptent'), json_extract(j.value, '$.amin'), json_extract(j.value, '$.amax'),
  json_extract(j.value, '$.umin'), json_extract(j.value, '$.umax'), json_extract(j.value, '$.plans'), json_extract(j.value, '$.status'),
  json_extract(j.value, '$.label'), json_extract(j.value, '$.dtext'), json_extract(j.value, '$.dym'), json_extract(j.value, '$.dimm'),
  json_extract(j.value, '$.url'), ?2, ?2, json_extract(j.value, '$.pmin'), json_extract(j.value, '$.pmax'), 0, 0, 0, NULL, ?3
FROM json_each(?4) AS j WHERE true
ON CONFLICT (source, external_id) DO UPDATE SET
  listing_type = excluded.listing_type, ward_code = excluded.ward_code, building_name = excluded.building_name,
  address = excluded.address, line_name = excluded.line_name, station_name = excluded.station_name,
  walk_minutes = excluded.walk_minutes, bus = excluded.bus,
  price_change_count = new_listings.price_change_count +
    (CASE WHEN excluded.price_min IS NOT new_listings.price_min OR excluded.price_max IS NOT new_listings.price_max THEN 1 ELSE 0 END),
  price_min = excluded.price_min, price_max = excluded.price_max,
  first_price_min = COALESCE(new_listings.first_price_min, excluded.price_min),
  first_price_max = COALESCE(new_listings.first_price_max, excluded.price_max),
  price_undecided = excluded.price_undecided, price_tentative = excluded.price_tentative,
  area_min = excluded.area_min, area_max = excluded.area_max,
  unit_price_min = excluded.unit_price_min, unit_price_max = excluded.unit_price_max, floor_plans = excluded.floor_plans,
  sale_status = excluded.sale_status, sale_label = excluded.sale_label, delivery_text = excluded.delivery_text,
  delivery_ym = excluded.delivery_ym, delivery_immediate = excluded.delivery_immediate, url = excluded.url,
  last_seen = excluded.last_seen,
  relisted_count = new_listings.relisted_count + (CASE WHEN new_listings.delisted_on IS NOT NULL THEN 1 ELSE 0 END),
  delisted_on = NULL, missed_runs = 0, last_seen_run = excluded.last_seen_run`;

const INSERT_NEW_HISTORY = `
INSERT INTO new_listing_price_history (source, external_id, observed_on, price_min, price_max)
SELECT ?1, json_extract(j.value, '$.id'), ?2, json_extract(j.value, '$.pmin'), json_extract(j.value, '$.pmax')
FROM json_each(?3) AS j WHERE true
ON CONFLICT (source, external_id, observed_on) DO UPDATE SET price_min = excluded.price_min, price_max = excluded.price_max`;

const SHINCHIKU_STORE: ListingStore<NewListingRecord> = {
  sourceId: CRAWL_KINDS.shinchiku.sourceId,
  table: "new_listings",
  async pageStatements(db, runId, date, areaCode, records) {
    const byId = new Map(records.map((r) => [r.externalId, r]));
    const prev = await db
      .prepare(
        "SELECT external_id, price_min, price_max FROM new_listings WHERE source = ?1 AND external_id IN (SELECT value FROM json_each(?2))",
      )
      .bind(this.sourceId, JSON.stringify([...byId.keys()]))
      .all<{ external_id: string; price_min: number | null; price_max: number | null }>();
    const prevPrice = new Map(prev.results.map((r) => [r.external_id, r]));
    let newCount = 0;
    let changedCount = 0;
    const history: { id: string; pmin: number | null; pmax: number | null }[] = [];
    for (const r of byId.values()) {
      const pmin = r.priceMin ?? null;
      const pmax = r.priceMax ?? null;
      const p = prevPrice.get(r.externalId);
      if (!p) {
        newCount++;
        history.push({ id: r.externalId, pmin, pmax });
      } else if (p.price_min !== pmin || p.price_max !== pmax) {
        changedCount++;
        history.push({ id: r.externalId, pmin, pmax });
      }
    }
    const b = (v: boolean | undefined) => (v ? 1 : 0);
    const rows = [...byId.values()].map((r) => ({
      id: r.externalId,
      type: r.listingType,
      ward: r.wardCode ?? areaCode,
      name: r.buildingName ?? null,
      addr: r.address ?? null,
      line: r.lineName ?? null,
      st: r.stationName ?? null,
      walk: r.walkMinutes ?? null,
      bus: b(r.bus),
      pmin: r.priceMin ?? null,
      pmax: r.priceMax ?? null,
      pund: b(r.priceUndecided),
      ptent: b(r.priceTentative),
      amin: r.areaMin ?? null,
      amax: r.areaMax ?? null,
      umin: r.unitPriceMin ?? null,
      umax: r.unitPriceMax ?? null,
      plans: r.floorPlans ?? null,
      status: r.saleStatus ?? null,
      label: r.saleLabel ?? null,
      dtext: r.deliveryText ?? null,
      dym: r.deliveryYm ?? null,
      dimm: b(r.deliveryImmediate),
      url: r.url ?? null,
    }));
    const stmts: D1PreparedStatement[] = [];
    if (history.length) stmts.push(db.prepare(INSERT_NEW_HISTORY).bind(this.sourceId, date, JSON.stringify(history)));
    stmts.push(db.prepare(UPSERT_NEW_LISTINGS).bind(this.sourceId, date, runId, JSON.stringify(rows)));
    return { stmts, newCount, changedCount, rows: rows.length };
  },
};

/** 1 ページぶんを 1 回の D1 batch（= 1 トランザクション）で反映する。カーソルも同じ batch で進める（途中で落ちても二重計上しない） */
async function applyPage<R>(
  db: D1Database,
  source: PagedSource<R>,
  store: ListingStore<R>,
  runId: string,
  date: string,
  cur: CursorRow,
  page: ParsedListPage<R>,
  url: string,
  at: string,
): Promise<void> {
  const p = cur.next_page;
  let totalHits = cur.total_hits;
  let totalPages = cur.total_pages;
  if (p === 1 || totalPages === null) {
    const hits = page.zeroHits ? 0 : page.totalHits;
    if (hits === null) {
      await cursorError(db, runId, source.id, cur, url, "件数表示が見つからない（構造変更の疑い）", at);
      return;
    }
    totalHits = hits;
    totalPages = hits === 0 ? 0 : Math.ceil(hits / source.pageSize);
  }
  if (page.maxPageLinked !== null && page.maxPageLinked > totalPages) totalPages = page.maxPageLinked;
  totalPages = Math.min(totalPages, CRAWL.maxPagesPerArea);

  if (page.records.length === 0 && page.skipped === 0) {
    if (page.zeroHits || p > 1) {
      await cursorDone(db, runId, cur, totalPages, totalHits, 0, at);
      return;
    }
    await cursorError(db, runId, source.id, cur, url, `物件 0 件（件数表示は ${totalHits} 件）`, at);
    return;
  }

  const { stmts, newCount, changedCount, rows } = await store.pageStatements(db, runId, date, cur.area_code, page.records);

  const next = p + 1;
  const done = next > totalPages;
  stmts.push(
    db
      .prepare(
        `UPDATE listing_crawl_cursor SET next_page = ?, total_pages = ?, total_hits = ?, seen = seen + ?, status = ?,
           attempts = 0, last_error = NULL, updated_at = ? WHERE run_id = ? AND area_code = ?`,
      )
      .bind(next, totalPages, totalHits, rows, done ? "done" : "pending", at, runId, cur.area_code),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE listing_crawl_runs SET new_count = new_count + ?,
           price_change_count = price_change_count + ?, skipped_count = skipped_count + ?, updated_at = ? WHERE run_id = ?`,
      )
      .bind(newCount, changedCount, page.skipped, at, runId),
  );
  await db.batch(stmts);
}

/** 全カーソルが終わった回を締める。complete のときだけ掲載終了を付ける */
async function finalizeRun(
  db: D1Database,
  store: StoreInfo,
  runId: string,
  date: string,
  at: string,
): Promise<{ status: CrawlSummary["status"]; runId: string; detail?: string }> {
  const source = store.sourceId;
  // 表名は ListingStore の定数（"listings" | "new_listings"）だけ。外からの値は入らない
  const table = store.table;
  const agg = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, SUM(COALESCE(total_hits, 0)) AS hits
       FROM listing_crawl_cursor WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{ errors: number | null; hits: number | null }>();
  const seenRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source = ? AND last_seen_run = ?`)
    .bind(source, runId)
    .first<{ n: number }>();
  const seen = seenRow?.n ?? 0;
  const hits = agg?.hits ?? 0;

  const incomplete = async (note: string) => {
    await db.batch([
      db
        .prepare(
          `UPDATE listing_crawl_runs SET status = 'incomplete', finished_at = ?, lease_until = NULL, listings_seen = ?,
             total_hits = ?, updated_at = ?, note = COALESCE(note || ' / ', '') || ? WHERE run_id = ?`,
        )
        .bind(at, seen, hits, at, note, runId),
      event(db, source, runId, "skipped_delist", null, null, note, at),
    ]);
    return { status: "incomplete" as const, runId, detail: note };
  };

  if ((agg?.errors ?? 0) > 0) return incomplete(`取れなかった市区町村が ${agg?.errors} 件あるため掲載終了を付けない`);
  if (hits > 0 && seen < hits * CRAWL.minSeenRatio) {
    return incomplete(`見えた件数 ${seen} がヒット件数合計 ${hits} の ${Math.round(CRAWL.minSeenRatio * 100)}% 未満のため掲載終了を付けない`);
  }

  await db.batch([
    db
      .prepare(
        `UPDATE ${table} SET missed_runs = missed_runs + 1
         WHERE source = ? AND delisted_on IS NULL AND (last_seen_run IS NULL OR last_seen_run <> ?)`,
      )
      .bind(source, runId),
    db
      .prepare(`UPDATE ${table} SET delisted_on = ? WHERE source = ? AND delisted_on IS NULL AND missed_runs >= ?`)
      .bind(date, source, CRAWL.delistAfterMissedCompleteRuns),
    db
      .prepare(
        `UPDATE listing_crawl_runs SET status = 'complete', finished_at = ?, lease_until = NULL, listings_seen = ?, total_hits = ?,
           gone_count = (SELECT COUNT(*) FROM ${table} WHERE source = ? AND delisted_on = ?), updated_at = ?
         WHERE run_id = ?`,
      )
      .bind(at, seen, hits, source, date, at, runId),
    db
      .prepare(
        `INSERT OR REPLACE INTO listing_snapshots (source, snapshot_on, seen_count, new_count, gone_count)
         SELECT source, crawl_date, listings_seen, new_count, gone_count FROM listing_crawl_runs WHERE run_id = ?`,
      )
      .bind(runId),
    event(db, source, runId, "finalized", null, null, `seen=${seen} hits=${hits}`, at),
  ]);
  return { status: "complete", runId };
}

function parseEventDetail(row: { at: string; run_id: string | null; detail: string | null } | null) {
  if (!row) return null;
  let detail: unknown = row.detail;
  try {
    detail = JSON.parse(row.detail ?? "null");
  } catch {
    /* 文字列のまま */
  }
  return { at: row.at, runId: row.run_id, result: detail };
}

export async function buildListingStatus(env: Env) {
  const source = SUUMO_SOURCE_ID;
  const mode = listingsMode(env);
  const activeKey = mode === "external" ? LOCAL_STATE_KEY : source;
  const [states, runs, cursors, events, lastCron, lastLocal] = await Promise.all([
    env.DB.prepare(
      "SELECT source AS fetcher, last_fetch_at, cooldown_until, last_block_kind, last_block_at FROM listing_crawl_state WHERE source IN (?, ?)",
    )
      .bind(source, LOCAL_STATE_KEY)
      .all<{ fetcher: string; last_fetch_at: string | null; cooldown_until: string | null; last_block_kind: string | null; last_block_at: string | null }>(),
    env.DB.prepare(
      `SELECT run_id, crawl_date, status, started_at, finished_at, invocations, pages_fetched, listings_seen, total_hits,
         new_count, price_change_count, gone_count, skipped_count, note
       FROM listing_crawl_runs WHERE source = ? ORDER BY crawl_date DESC LIMIT 14`,
    )
      .bind(source)
      .all(),
    env.DB.prepare(
      `SELECT area_code, slug, next_page, total_pages, total_hits, seen, status, attempts, last_error
       FROM listing_crawl_cursor WHERE run_id = (SELECT run_id FROM listing_crawl_runs WHERE source = ? ORDER BY crawl_date DESC LIMIT 1)
       ORDER BY sort_order`,
    )
      .bind(source)
      .all(),
    env.DB.prepare(
      "SELECT at, kind, http_status, url, detail FROM listing_crawl_events WHERE source = ? AND kind NOT IN ('cron', 'local') ORDER BY id DESC LIMIT 20",
    )
      .bind(source)
      .all(),
    env.DB.prepare("SELECT at, run_id, detail FROM listing_crawl_events WHERE source = ? AND kind = 'cron' ORDER BY id DESC LIMIT 1")
      .bind(source)
      .first<{ at: string; run_id: string | null; detail: string | null }>(),
    env.DB.prepare("SELECT at, run_id, detail FROM listing_crawl_events WHERE source = ? AND kind = 'local' ORDER BY id DESC LIMIT 1")
      .bind(source)
      .first<{ at: string; run_id: string | null; detail: string | null }>(),
  ]);
  const state = states.results.find((s) => s.fetcher === activeKey) ?? null;
  return {
    /** off 以外なら true（on = Worker cron が取る / external = Mac から受け取る） */
    enabled: mode !== "off",
    mode,
    cron: LISTINGS_CRON,
    /** cron が実際に起動した最後の記録（on のときだけ残る）。null なら on にしてから一度も起動していない */
    lastCronRun: parseEventDetail(lastCron),
    /** Mac 側クローラの最後の実行（external のとき。{op:"end"} で残る） */
    lastLocalRun: parseEventDetail(lastLocal),
    settings: { intervalMs: crawlSettings(env).intervalMs, fakeOrigin: localOrigin(env) },
    /** いまのモードで取っている取得元の状態（external なら Mac 側） */
    state,
    /** 取得元ごとの状態（Worker = SUUMO_SOURCE_ID、Mac = LOCAL_STATE_KEY） */
    states: states.results,
    runs: runs.results,
    latestCursors: cursors.results,
    events: events.results,
  };
}

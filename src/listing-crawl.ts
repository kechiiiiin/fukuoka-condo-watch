// 掲載情報（SUUMO）の日次クロール。**LISTINGS_ENABLED が on のときだけ動く（既定 off・off なら D1 にも触らず即 return）**。
//
// 設計（Workers Paid 前提。2026-09 確認: Cron の CPU 30s（1 時間未満間隔）/ 実行時間 15 分 / サブリクエスト 10,000）
//   - 1 日ぶん ≒ 福岡市 180 ページ + 近郊 51 ページ ≒ 231 ページ（2026-09-14 の件数から）
//   - 1 ページごとに 6 秒以上あける（下限 5 秒。state.last_fetch_at で起動をまたいでも守る）
//     → 1 ページ ≒ 6 秒 + 応答 1〜2 秒 ≒ 7.5 秒 → 231 ページ ≒ 29 分。1 起動には収まらない
//   - cron `*/20 16-17 * * *`（01:00〜02:40 JST・6 起動）で分割。1 起動は 10 分で自主的に切り上げ（15 分上限まで 5 分の余裕）。
//     1 起動 ≒ 80 ページなので 3 起動で終わり、残り 3 起動は失敗時の再開の余裕。取り切った後の起動は数クエリで終わる
//   - 進み具合は D1（listing_crawl_cursor）に 1 ページごとに保存 → どこで落ちても次の起動が続きから
//   - D1 は 1 起動あたり 1,000 クエリ（Paid）。1 ページ ≒ 7 クエリ × 上限 100 ページ + 20 ≒ 720 に収める
//   - 403 / 429 / 503 / captcha らしき応答 / 一覧の構造が無い → その日は打ち切り、72 時間クールダウンして記録
//   - 「掲載終了」は全市区町村を取り切った回（complete）でだけ付ける。途中で止まった回・件数が合わない回では付けない
//
// Free プランで何が壊れるか（README にも記載）:
//   - CPU 10ms/起動: 230KB の HTML を 1〜数ページ解析した時点で超える → Exceeded CPU で落ちる
//   - サブリクエスト 50/起動・D1 クエリ 50/起動: 1 起動 7 ページ前後で上限
//   → 231 ページを 6 秒間隔で取るには 1 日 30 起動以上が要り、cron の起動回数・取得時刻の幅も現実的でない

import type { Env } from "./env";
import { jstToday } from "./ingest";
import type { CrawlTarget, PagedListingSource, ParsedListPage } from "./listing";
import { SuumoSource } from "./suumo-source";

/** wrangler.toml の crons と一致させること（scheduled のディスパッチに使う） */
export const LISTINGS_CRON = "*/20 16-17 * * *";

export const CRAWL = {
  /** 既定のページ間隔 */
  minIntervalMs: 6000,
  /** 本番（suumo.jp）で許す最小間隔。LISTINGS_MIN_INTERVAL_MS でもこれより短くできない */
  floorIntervalMs: 5000,
  /** 1 起動の持ち時間（Cron の実行時間上限 15 分に対し余裕 5 分） */
  runBudgetMs: 10 * 60_000,
  fetchTimeoutMs: 30_000,
  /** 二重起動よけ（前の起動が落ちてもこの時間で解ける） */
  leaseMs: 14 * 60_000,
  /** 同じページの失敗がこの回数に達したら、その市区町村はその日 error（= その回は complete にならない） */
  maxAttempts: 3,
  cooldownHours: 72,
  maxPagesPerArea: 150,
  /** D1 クエリ上限（Paid 1,000/起動）から逆算 */
  maxPagesPerInvocation: 100,
  /** 取り切った回でも、見えた件数がヒット件数合計のこの割合未満なら掲載終了を付けない（取りこぼしの疑い） */
  minSeenRatio: 0.85,
  /** complete な回で何回続けて見えなかったら掲載終了にするか */
  delistAfterMissedCompleteRuns: 1,
};

export function listingsEnabled(env: Pick<Env, "LISTINGS_ENABLED">): boolean {
  const v = (env.LISTINGS_ENABLED ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/** SUUMO_ORIGIN はローカルの偽サーバ（http://127.0.0.1 / localhost）だけ受け付ける。それ以外は無視して suumo.jp */
export function localOrigin(env: Pick<Env, "SUUMO_ORIGIN">): string | null {
  const o = env.SUUMO_ORIGIN?.trim();
  if (!o) return null;
  try {
    const u = new URL(o);
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return u.origin;
  } catch {
    /* 無視 */
  }
  return null;
}

export interface CrawlSettings {
  origin: string | undefined;
  intervalMs: number;
  budgetMs: number;
  maxPages: number;
  todayOverride: string | null;
  userAgent: string | undefined;
}

export function crawlSettings(env: Env): CrawlSettings {
  const local = localOrigin(env);
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const reqInterval = num(env.LISTINGS_MIN_INTERVAL_MS);
  // 間隔・持ち時間・日付の上書きは偽サーバ相手のときだけ効く（本番で間隔を詰められないように）
  const intervalMs = local
    ? Math.max(0, reqInterval ?? CRAWL.minIntervalMs)
    : Math.max(CRAWL.floorIntervalMs, reqInterval ?? CRAWL.minIntervalMs);
  const budget = local ? num(env.LISTINGS_RUN_BUDGET_MS) : null;
  const maxPages = local ? num(env.LISTINGS_MAX_PAGES_PER_INVOCATION) : null;
  const today = local && /^\d{4}-\d{2}-\d{2}$/.test(env.LISTINGS_TODAY_OVERRIDE ?? "") ? env.LISTINGS_TODAY_OVERRIDE! : null;
  return {
    origin: local ?? undefined,
    intervalMs,
    budgetMs: budget && budget > 0 ? Math.min(budget, CRAWL.runBudgetMs) : CRAWL.runBudgetMs,
    maxPages: maxPages && maxPages > 0 ? Math.min(maxPages, CRAWL.maxPagesPerInvocation) : CRAWL.maxPagesPerInvocation,
    todayOverride: today,
    userAgent: env.LISTINGS_USER_AGENT?.trim() || undefined,
  };
}

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
  status: "disabled" | "cooldown" | "locked" | "running" | "complete" | "incomplete" | "blocked";
  runId?: string;
  pages: number;
  detail?: string;
}

interface CursorRow {
  area_code: string;
  slug: string;
  next_page: number;
  total_pages: number | null;
  total_hits: number | null;
  attempts: number;
}

export async function runListingCrawl(env: Env, deps: CrawlDeps = defaultDeps): Promise<CrawlSummary> {
  if (!listingsEnabled(env)) {
    console.log("LISTINGS_ENABLED が on ではないため掲載クロールはスキップ");
    return { status: "disabled", pages: 0 };
  }
  const s = crawlSettings(env);
  const source = new SuumoSource({ origin: s.origin, userAgent: s.userAgent, minIntervalMs: s.intervalMs });
  const db = env.DB;
  const startedMs = deps.now();
  const iso = (ms = deps.now()) => new Date(ms).toISOString();
  const date = s.todayOverride ?? jstToday(new Date(startedMs));
  const runId = `${source.id}:${date}`;

  await db.prepare("INSERT OR IGNORE INTO listing_crawl_state (source) VALUES (?)").bind(source.id).run();
  const state = await db
    .prepare("SELECT last_fetch_at, cooldown_until FROM listing_crawl_state WHERE source = ?")
    .bind(source.id)
    .first<{ last_fetch_at: string | null; cooldown_until: string | null }>();
  if (state?.cooldown_until && state.cooldown_until > iso()) {
    console.log(`掲載クロールはクールダウン中（${state.cooldown_until} まで）`);
    return { status: "cooldown", pages: 0, detail: state.cooldown_until };
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
  if (!run || run.status !== "running") return { status: run?.status ?? "incomplete", runId, pages: 0 };

  const lease = await db
    .prepare(
      `UPDATE listing_crawl_runs SET lease_until = ?, invocations = invocations + 1, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(iso(startedMs + CRAWL.leaseMs), iso(), runId, iso())
    .run();
  if (!lease.meta.changes) return { status: "locked", runId, pages: 0 };

  let lastFetch = state?.last_fetch_at ? Date.parse(state.last_fetch_at) : 0;
  let pages = 0;
  try {
    for (;;) {
      const cur = await db
        .prepare(
          `SELECT area_code, slug, next_page, total_pages, total_hits, attempts FROM listing_crawl_cursor
           WHERE run_id = ? AND status = 'pending' ORDER BY attempts, sort_order LIMIT 1`,
        )
        .bind(runId)
        .first<CursorRow>();
      if (!cur) break;
      if (pages >= s.maxPages) break;
      const wait = Math.max(0, lastFetch + s.intervalMs - deps.now());
      if (deps.now() - startedMs + wait + CRAWL.fetchTimeoutMs > s.budgetMs) break;
      if (wait > 0) await deps.sleep(wait);

      const target: CrawlTarget = { areaCode: cur.area_code, key: cur.slug };
      const url = source.pageUrl(target, cur.next_page);
      lastFetch = deps.now();
      // 取りに行く前に記録する（0 件ページ・404・失敗も「1 リクエスト」として数え、間隔の起点にする）
      await db.batch([
        db.prepare("UPDATE listing_crawl_state SET last_fetch_at = ? WHERE source = ?").bind(iso(lastFetch), source.id),
        db.prepare("UPDATE listing_crawl_runs SET pages_fetched = pages_fetched + 1 WHERE run_id = ?").bind(runId),
      ]);
      pages++;

      let status: number;
      let html: string;
      try {
        const res = await deps.fetch(url, {
          headers: { "user-agent": source.userAgent, accept: "text/html", "accept-language": "ja" },
          redirect: "manual",
          signal: AbortSignal.timeout(CRAWL.fetchTimeoutMs),
        });
        status = res.status;
        html = await res.text();
      } catch (e) {
        await cursorError(db, runId, source.id, cur, url, `fetch 失敗: ${String(e)}`, iso());
        continue;
      }

      const block = source.detectBlock(status, html);
      if (block) {
        const until = iso(deps.now() + CRAWL.cooldownHours * 3600_000);
        await db.batch([
          db
            .prepare("UPDATE listing_crawl_state SET cooldown_until = ?, last_block_kind = ?, last_block_at = ? WHERE source = ?")
            .bind(until, block, iso(), source.id),
          db
            .prepare(
              `UPDATE listing_crawl_runs SET status = 'blocked', finished_at = ?, lease_until = NULL, updated_at = ?,
                 note = COALESCE(note || ' / ', '') || ? WHERE run_id = ?`,
            )
            .bind(iso(), iso(), `${block} で停止（${until} までクールダウン）`, runId),
          event(db, source.id, runId, "blocked", status, url, `${block}; cooldown_until=${until}; body_head=${html.slice(0, 200)}`, iso()),
        ]);
        console.warn(`掲載クロール停止: ${block} ${status} ${url}`);
        return { status: "blocked", runId, pages, detail: block };
      }

      if (cur.next_page > 1 && (status === 404 || (status >= 300 && status < 400))) {
        // 取っている間に件数が減って、最後のページが無くなった
        await cursorDone(db, runId, cur, cur.total_pages, cur.total_hits, 0, iso());
        continue;
      }
      if (status !== 200) {
        await cursorError(db, runId, source.id, cur, url, `HTTP ${status}`, iso());
        continue;
      }
      await applyPage(db, source, runId, date, cur, source.parsePage(html, target), url, iso());
    }

    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM listing_crawl_cursor WHERE run_id = ? AND status = 'pending'")
      .bind(runId)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) > 0) return { status: "running", runId, pages };
    return { ...(await finalizeRun(db, source.id, runId, date, iso())), pages };
  } finally {
    await db.prepare("UPDATE listing_crawl_runs SET lease_until = NULL WHERE run_id = ? AND status = 'running'").bind(runId).run();
    console.log(JSON.stringify({ listingCrawl: { runId, pages } }));
  }
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

const UPSERT_LISTINGS = `
INSERT INTO listings (source, external_id, kind, ward_code, building_name, building_year, built_month, area_sqm, floor_plan,
  line_name, station_name, walk_minutes, bus, address, url, first_seen, last_seen, current_price, first_price,
  price_cut_count, relisted_count, missed_runs, delisted_on, last_seen_run)
SELECT ?1, json_extract(j.value, '$.id'), 'sale', json_extract(j.value, '$.ward'), json_extract(j.value, '$.name'),
  json_extract(j.value, '$.by'), json_extract(j.value, '$.bm'), json_extract(j.value, '$.area'), json_extract(j.value, '$.plan'),
  json_extract(j.value, '$.line'), json_extract(j.value, '$.st'), json_extract(j.value, '$.walk'), json_extract(j.value, '$.bus'),
  json_extract(j.value, '$.addr'), json_extract(j.value, '$.url'), ?2, ?2, json_extract(j.value, '$.price'),
  json_extract(j.value, '$.price'), 0, 0, 0, NULL, ?3
FROM json_each(?4) AS j WHERE true
ON CONFLICT (source, external_id) DO UPDATE SET
  ward_code = excluded.ward_code, building_name = excluded.building_name, building_year = excluded.building_year,
  built_month = excluded.built_month, area_sqm = excluded.area_sqm, floor_plan = excluded.floor_plan,
  line_name = excluded.line_name, station_name = excluded.station_name, walk_minutes = excluded.walk_minutes,
  bus = excluded.bus, address = excluded.address, url = excluded.url,
  last_seen = excluded.last_seen,
  price_cut_count = listings.price_cut_count + (CASE WHEN excluded.current_price < listings.current_price THEN 1 ELSE 0 END),
  current_price = excluded.current_price,
  relisted_count = listings.relisted_count + (CASE WHEN listings.delisted_on IS NOT NULL THEN 1 ELSE 0 END),
  delisted_on = NULL, missed_runs = 0, last_seen_run = excluded.last_seen_run`;

const INSERT_HISTORY = `
INSERT INTO listing_price_history (source, external_id, observed_on, price)
SELECT ?1, json_extract(j.value, '$.id'), ?2, json_extract(j.value, '$.price') FROM json_each(?3) AS j WHERE true
ON CONFLICT (source, external_id, observed_on) DO UPDATE SET price = excluded.price`;

/** 1 ページぶんを 1 回の D1 batch（= 1 トランザクション）で反映する。カーソルも同じ batch で進める（途中で落ちても二重計上しない） */
async function applyPage(
  db: D1Database,
  source: PagedListingSource,
  runId: string,
  date: string,
  cur: CursorRow,
  page: ParsedListPage,
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

  const byId = new Map(page.records.map((r) => [r.externalId, r]));
  const ids = [...byId.keys()];
  const prev = await db
    .prepare(
      "SELECT external_id, current_price FROM listings WHERE source = ?1 AND external_id IN (SELECT value FROM json_each(?2))",
    )
    .bind(source.id, JSON.stringify(ids))
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
    ward: r.wardCode ?? cur.area_code,
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
  }));

  const next = p + 1;
  const done = next > totalPages;
  const stmts: D1PreparedStatement[] = [];
  // 履歴は listings を更新する前に（新規・価格変更の判定は上の prev で済ませてある）
  if (history.length) stmts.push(db.prepare(INSERT_HISTORY).bind(source.id, date, JSON.stringify(history)));
  stmts.push(db.prepare(UPSERT_LISTINGS).bind(source.id, date, runId, JSON.stringify(rows)));
  stmts.push(
    db
      .prepare(
        `UPDATE listing_crawl_cursor SET next_page = ?, total_pages = ?, total_hits = ?, seen = seen + ?, status = ?,
           attempts = 0, last_error = NULL, updated_at = ? WHERE run_id = ? AND area_code = ?`,
      )
      .bind(next, totalPages, totalHits, rows.length, done ? "done" : "pending", at, runId, cur.area_code),
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
  source: string,
  runId: string,
  date: string,
  at: string,
): Promise<{ status: CrawlSummary["status"]; runId: string; detail?: string }> {
  const agg = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, SUM(COALESCE(total_hits, 0)) AS hits
       FROM listing_crawl_cursor WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{ errors: number | null; hits: number | null }>();
  const seenRow = await db
    .prepare("SELECT COUNT(*) AS n FROM listings WHERE source = ? AND last_seen_run = ?")
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
        `UPDATE listings SET missed_runs = missed_runs + 1
         WHERE source = ? AND delisted_on IS NULL AND (last_seen_run IS NULL OR last_seen_run <> ?)`,
      )
      .bind(source, runId),
    db
      .prepare("UPDATE listings SET delisted_on = ? WHERE source = ? AND delisted_on IS NULL AND missed_runs >= ?")
      .bind(date, source, CRAWL.delistAfterMissedCompleteRuns),
    db
      .prepare(
        `UPDATE listing_crawl_runs SET status = 'complete', finished_at = ?, lease_until = NULL, listings_seen = ?, total_hits = ?,
           gone_count = (SELECT COUNT(*) FROM listings WHERE source = ? AND delisted_on = ?), updated_at = ?
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

export async function buildListingStatus(env: Env) {
  const source = "suumo:ms-chuko";
  const [state, runs, cursors, events] = await Promise.all([
    env.DB.prepare("SELECT last_fetch_at, cooldown_until, last_block_kind, last_block_at FROM listing_crawl_state WHERE source = ?")
      .bind(source)
      .first(),
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
    env.DB.prepare("SELECT at, kind, http_status, url, detail FROM listing_crawl_events WHERE source = ? ORDER BY id DESC LIMIT 20")
      .bind(source)
      .all(),
  ]);
  return {
    enabled: listingsEnabled(env),
    cron: LISTINGS_CRON,
    settings: { intervalMs: crawlSettings(env).intervalMs, fakeOrigin: localOrigin(env) },
    state,
    runs: runs.results,
    latestCursors: cursors.results,
    events: events.results,
  };
}

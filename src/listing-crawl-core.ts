// 掲載クロールのうち「取りに行く側」の共通部品。Workers（cron）と Node（Mac 側クローラ）の両方から使う。
// D1・Env に依存させないこと（scripts/ の tsconfig には Workers の型が無い）。
//
//   - LISTINGS_ENABLED の解釈（off / on / external）
//   - ページ間隔などの設定（偽サーバ相手のときだけ詰められる）
//   - 1 ページ取って「止まる／失敗／ページ消滅／解析済み」に振り分ける（PageOutcome）
//   - Mac → Worker 取り込み（POST /api/listings/ingest）の要求の形と検証
//
// D1 への反映（カーソル・掲載終了の判定）は src/listing-crawl.ts に 1 つだけある。

import type { CrawlTarget, ListingRecord, PagedSource, ParsedListPage } from "./listing-types";

export const CRAWL = {
  /** 既定のページ間隔 */
  minIntervalMs: 60_000,
  /**
   * 本番（suumo.jp）で許す最小間隔。LISTINGS_MIN_INTERVAL_MS でもこれより短くできない。
   * 2026-09-14 に 6 秒間隔で 43 ページ目に 503 を返されたため 60 秒（2026-09-22 に 20 → 30 → 60 秒へ。時間より相手への負担の小ささを優先）
   */
  floorIntervalMs: 60_000,
  /** Worker cron 1 起動の持ち時間（Cron の実行時間上限 15 分に対し余裕 5 分） */
  runBudgetMs: 10 * 60_000,
  fetchTimeoutMs: 30_000,
  /** 二重起動よけ（前の起動が落ちてもこの時間で解ける） */
  leaseMs: 14 * 60_000,
  /** Mac からの取り込み: 1 ページ受けるたびにこの長さだけ借り直す（Mac が落ちてもこの時間で解ける） */
  ingestLeaseMs: 10 * 60_000,
  /** 同じページの失敗がこの回数に達したら、その市区町村はその日 error（= その回は complete にならない） */
  maxAttempts: 3,
  cooldownHours: 72,
  maxPagesPerArea: 150,
  /** D1 クエリ上限（Paid 1,000/起動）から逆算 */
  maxPagesPerInvocation: 100,
  /** Mac 側 1 回の実行の上限（1 日 ≒ 231 ページ。それを大きく超えたら何かおかしい） */
  localMaxPagesPerRun: 500,
  /** Mac 側 1 回の実行の上限時間（231 ページ × 61 秒 ≒ 4 時間） */
  localMaxRunMs: 6 * 3600_000,
  /** 取り切った回でも、見えた件数がヒット件数合計のこの割合未満なら掲載終了を付けない（取りこぼしの疑い） */
  minSeenRatio: 0.85,
  /** complete な回で何回続けて見えなかったら掲載終了にするか（1 だとクロール中の並びずれで誤判定するため 2） */
  delistAfterMissedCompleteRuns: 2,
};

/**
 * LISTINGS_ENABLED:
 *   - "off"（既定・未設定・不明な値）… 何もしない。cron は D1 にも触らず即 return、取り込みも拒否
 *   - "on" / "1" / "true" … Worker の cron が SUUMO を取りに行く（2026-09-14〜09-22 の方式。Cloudflare の送信元が 503 で弾かれた）
 *   - "external" … cron は取りに行かない。Mac（launchd）が取ってきたページを POST /api/listings/ingest で受けるだけ
 */
export type ListingsMode = "off" | "on" | "external";

export function listingsMode(env: { LISTINGS_ENABLED?: string }): ListingsMode {
  const v = (env.LISTINGS_ENABLED ?? "").trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return "on";
  if (v === "external") return "external";
  return "off";
}

/** SUUMO_ORIGIN はローカルの偽サーバ（http://127.0.0.1 / localhost）だけ受け付ける。それ以外は無視して suumo.jp */
export function localOrigin(env: { SUUMO_ORIGIN?: string }): string | null {
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

export interface CrawlEnvLike {
  SUUMO_ORIGIN?: string;
  LISTINGS_MIN_INTERVAL_MS?: string;
  LISTINGS_RUN_BUDGET_MS?: string;
  LISTINGS_MAX_PAGES_PER_INVOCATION?: string;
  LISTINGS_TODAY_OVERRIDE?: string;
  LISTINGS_USER_AGENT?: string;
}

export interface CrawlSettings {
  origin: string | undefined;
  intervalMs: number;
  budgetMs: number;
  maxPages: number;
  todayOverride: string | null;
  userAgent: string | undefined;
}

export function crawlSettings(env: CrawlEnvLike): CrawlSettings {
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

/** 1 ページ取った結果。D1 への反映は src/listing-crawl.ts の applyOutcome */
export type PageOutcome =
  /** 通信そのものが失敗（タイムアウト等）→ そのページの attempts + 1 */
  | { kind: "fetch_error"; message: string }
  /** 403/429/503/captcha/構造なし/ボット確認への 3xx → その日は打ち切り・72 時間クールダウン */
  | { kind: "blocked"; block: string; status: number; location: string | null; bodyHead: string }
  /** 2 ページ目以降の 404・3xx（取っている間に件数が減り、最後のページが無くなった）→ その市区町村は done */
  | { kind: "gone"; status: number }
  /** その他の 200 以外 → attempts + 1 */
  | { kind: "http_error"; status: number }
  | { kind: "parsed"; page: ParsedListPage };

/** 応答を振り分ける（Worker cron と Mac で同じ判定を使う） */
export function classifyResponse(
  source: PagedSource,
  target: CrawlTarget,
  page: number,
  url: string,
  status: number,
  html: string,
  location: string | null,
): PageOutcome {
  // 3xx で別ホスト・ボット確認らしき先へ飛ばされたら 403/429 と同じく止まる（取り直さない）
  const block = source.detectBlock(status, html, { url, location });
  if (block) return { kind: "blocked", block, status, location: location ? location.slice(0, 300) : null, bodyHead: html.slice(0, 200) };
  if (page > 1 && (status === 404 || (status >= 300 && status < 400))) return { kind: "gone", status };
  if (status !== 200) return { kind: "http_error", status };
  return { kind: "parsed", page: source.parsePage(html, target) };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 1 ページ取って振り分ける。リダイレクトは追わない（manual） */
export async function fetchAndClassify(
  fetchImpl: FetchLike,
  source: PagedSource,
  target: CrawlTarget,
  page: number,
  url: string,
): Promise<PageOutcome> {
  let status: number;
  let html: string;
  let location: string | null;
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": source.userAgent, accept: "text/html", "accept-language": "ja" },
      redirect: "manual",
      signal: AbortSignal.timeout(CRAWL.fetchTimeoutMs),
    });
    status = res.status;
    location = res.headers.get("location");
    html = await res.text();
  } catch (e) {
    return { kind: "fetch_error", message: `fetch 失敗: ${String(e)}`.slice(0, 500) };
  }
  return classifyResponse(source, target, page, url, status, html, location);
}

/** 失敗・止まった応答の説明（events・cursor.last_error 用） */
export function outcomeMessage(o: PageOutcome): string {
  switch (o.kind) {
    case "fetch_error":
      return o.message;
    case "http_error":
      return `HTTP ${o.status}`;
    case "blocked":
      return `${o.block} (HTTP ${o.status})`;
    case "gone":
      return `HTTP ${o.status}（最後のページが無くなった）`;
    case "parsed":
      return `${o.page.records.length} 件`;
  }
}

// ---------------------------------------------------------------------------
// Mac → Worker の取り込み（POST /api/listings/ingest）
// ---------------------------------------------------------------------------

/** 取り込み時の状態の置き場（listing_crawl_state.source）。Worker cron の状態（SUUMO_SOURCE_ID）とは別にする */
export const LOCAL_FETCHER_SUFFIX = "@mac";

export type IngestRequest =
  /** 今日の回を開く（無ければ作る）。クールダウン・二重起動を確かめ、次に取るページを返す */
  | { op: "begin" }
  /** 1 ページぶんの結果を反映し、次に取るページを返す */
  | { op: "page"; runId: string; areaCode: string; page: number; url: string; fetchedAt: string; outcome: PageOutcome }
  /** 実行の終わり（借りを返し、結果を記録する） */
  | { op: "end"; runId: string; summary: { status: string; pages: number; detail?: string } };

export interface IngestCursor {
  areaCode: string;
  slug: string;
  page: number;
}

export interface IngestResponse {
  ok: boolean;
  /** running | complete | incomplete | blocked | cooldown | locked */
  status?: string;
  runId?: string;
  next?: IngestCursor | null;
  /** 前回ページを取った時刻（Mac はここから間隔を数える） */
  lastFetchAt?: string | null;
  /** 送ったページが既に反映済み・別の位置だった（二重送信）。next から続ける */
  stale?: boolean;
  detail?: string;
  error?: string;
}

const MAX_STR = 300;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function optStr(v: unknown, max = MAX_STR): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > max) throw new Error("文字列が不正");
  return v;
}
function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("数値が不正");
  return v;
}
function int(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error("整数が不正");
  return v;
}

function parseRecord(v: unknown): ListingRecord {
  if (!isObj(v)) throw new Error("物件が不正");
  const externalId = v.externalId;
  if (typeof externalId !== "string" || !/^[0-9A-Za-z_-]{1,40}$/.test(externalId)) throw new Error("externalId が不正");
  if (v.kind !== "sale") throw new Error("kind が不正");
  const price = v.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1e11) throw new Error("price が不正");
  if (v.bus !== undefined && typeof v.bus !== "boolean") throw new Error("bus が不正");
  const r: ListingRecord = { externalId, kind: "sale", price };
  const wardCode = optStr(v.wardCode, 5);
  if (wardCode !== undefined && !/^\d{5}$/.test(wardCode)) throw new Error("wardCode が不正");
  if (wardCode !== undefined) r.wardCode = wardCode;
  const s = (k: "districtName" | "buildingName" | "floorPlan" | "lineName" | "stationName" | "address" | "url") => {
    const x = optStr(v[k]);
    if (x !== undefined) r[k] = x;
  };
  s("districtName");
  s("buildingName");
  s("floorPlan");
  s("lineName");
  s("stationName");
  s("address");
  s("url");
  const n = (k: "buildingYear" | "builtMonth" | "areaSqm" | "walkMinutes") => {
    const x = optNum(v[k]);
    if (x !== undefined) r[k] = x;
  };
  n("buildingYear");
  n("builtMonth");
  n("areaSqm");
  n("walkMinutes");
  if (v.bus !== undefined) r.bus = v.bus as boolean;
  return r;
}

function parsePage(v: unknown): ParsedListPage {
  if (!isObj(v)) throw new Error("page が不正");
  if (typeof v.zeroHits !== "boolean") throw new Error("zeroHits が不正");
  if (!Array.isArray(v.records) || v.records.length > 200) throw new Error("records が不正");
  return {
    totalHits: v.totalHits === null ? null : int(v.totalHits, 0, 1_000_000),
    zeroHits: v.zeroHits,
    maxPageLinked: v.maxPageLinked === null ? null : int(v.maxPageLinked, 0, 100_000),
    records: v.records.map(parseRecord),
    skipped: int(v.skipped, 0, 10_000),
  };
}

function parseOutcome(v: unknown): PageOutcome {
  if (!isObj(v)) throw new Error("outcome が不正");
  switch (v.kind) {
    case "fetch_error":
      return { kind: "fetch_error", message: optStr(v.message, 500) ?? "" };
    case "blocked": {
      const block = v.block;
      if (typeof block !== "string" || !/^[a-z0-9_]{1,40}$/.test(block)) throw new Error("block が不正");
      return {
        kind: "blocked",
        block,
        status: int(v.status, 0, 999),
        location: optStr(v.location) ?? null,
        bodyHead: optStr(v.bodyHead, 400) ?? "",
      };
    }
    case "gone":
      return { kind: "gone", status: int(v.status, 0, 999) };
    case "http_error":
      return { kind: "http_error", status: int(v.status, 0, 999) };
    case "parsed":
      return { kind: "parsed", page: parsePage(v.page) };
    default:
      throw new Error("outcome.kind が不正");
  }
}

const RUN_ID = /^[a-z0-9:_-]{1,60}:\d{4}-\d{2}-\d{2}$/;

/** 取り込み要求を検証する。不正なら Error（メッセージは 400 の本文に出してよい程度のもの） */
export function parseIngestRequest(body: unknown): IngestRequest {
  if (!isObj(body)) throw new Error("本文が不正");
  switch (body.op) {
    case "begin":
      return { op: "begin" };
    case "page": {
      const runId = body.runId;
      if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("runId が不正");
      const areaCode = body.areaCode;
      if (typeof areaCode !== "string" || !/^\d{5}$/.test(areaCode)) throw new Error("areaCode が不正");
      const url = optStr(body.url, 500);
      if (!url || !/^https?:\/\//.test(url)) throw new Error("url が不正");
      const fetchedAt = body.fetchedAt;
      if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("fetchedAt が不正");
      return { op: "page", runId, areaCode, page: int(body.page, 1, 100_000), url, fetchedAt, outcome: parseOutcome(body.outcome) };
    }
    case "end": {
      const runId = body.runId;
      if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("runId が不正");
      const s = isObj(body.summary) ? body.summary : {};
      return {
        op: "end",
        runId,
        summary: {
          status: optStr(s.status, 40) ?? "unknown",
          pages: typeof s.pages === "number" && Number.isInteger(s.pages) && s.pages >= 0 ? s.pages : 0,
          detail: optStr(s.detail, 500),
        },
      };
    }
    default:
      throw new Error("op が不正");
  }
}

// SUUMO 掲載のクロール（Mac 側）。launchd（ops/launchd/）から起動する:
//   - 中古（既定・--kind chuko）… 毎日 01:00（com.kechiiiiin.fukuoka-condo-watch.suumo）
//   - 新築（--kind shinchiku）   … 毎週日曜 06:00（com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku）
// ⚠️ 私的・非商用の個人利用に限る（README「掲載情報（SUUMO）」）。
//
// なぜ Mac か: Worker の cron から取ると 2026-09-14 に 43 ページ目で 503、9/17・9/20 は 1 ページ目で即 503
// （Cloudflare Workers の送信元が弾かれている様子）。同じ URL を自宅回線から curl すると 200 だった。
//
// 役割の分担（二重実装しない）:
//   - 取得・ブロック判定・解析 … src/listing-crawl-core.ts の fetchAndClassify（Worker cron と同じ関数）
//   - D1 への反映・カーソル・掲載終了の判定 … Worker 側（POST /api/listings/ingest → src/listing-crawl.ts の applyOutcome）
//     Mac は「次にどのページを取るか」を毎回 Worker に聞き、1 ページ取るごとに結果を送る。落ちても翌日カーソルから続く
//
// 守ること:
//   - ページ間隔は 60 秒以上（suumo.jp 相手は CRAWL.floorIntervalMs 未満にできない。偽サーバ相手だけ短縮可）
//   - 403 / 429 / 503 / captcha 等を受けたら即打ち切り → Worker が Mac 側の取得元を 72 時間クールダウンにする
//   - 多重起動しない（ロックファイル。中古と新築で**同じ**ロックを使う = 同時に SUUMO を叩かない）。
//     別の実行が持っていたら、終わるまで最大 CRAWL.localLockWaitMs 待ってから取る（launchd が両方を同時に起こしても順番に走る）
//   - 1 回の実行は最大 CRAWL_KINDS[kind].localMaxPagesPerRun ページ・localMaxRunMs まで
//
// 設定（~/.config/fukuoka-condo-watch/env・chmod 600。FCW_ENV_FILE で場所を変えられる。環境変数が優先）:
//   LISTINGS_INGEST_URL=https://fukuoka-condo-watch.<sub>.workers.dev/api/listings/ingest
//   LISTINGS_INGEST_TOKEN=<Worker secret と同じ値>
//   # ↓ ローカル確認用（偽サーバ http://127.0.0.1:8790 のときだけ効く）
//   # SUUMO_ORIGIN=http://127.0.0.1:8790
//   # LISTINGS_MIN_INTERVAL_MS=0
//
//   npm run crawl:local                 # 普段は launchd から
//   npm run crawl:local -- --dry-run    # 設定の確認だけ（SUUMO にも Worker にもアクセスしない）
//   npm run crawl:local -- --max-pages 2  # 試し走り（2 ページで切り上げ。続きは次回カーソルから）
//   npm run crawl:local -- --kind shinchiku   # 新築（週 1 回・23 ページ ≒ 25 分）

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AnyListingRecord,
  CRAWL,
  CRAWL_KINDS,
  type CrawlKind,
  crawlSettings,
  fetchAndClassify,
  type IngestRequest,
  type IngestResponse,
  outcomeMessage,
  type PageOutcome,
} from "../src/listing-crawl-core";
import type { CrawlTarget } from "../src/listing-types";
import { ShinchikuSource } from "../src/suumo-shinchiku";
import { SuumoSource } from "../src/suumo-source";

const ENV_FILE = process.env.FCW_ENV_FILE || join(homedir(), ".config/fukuoka-condo-watch/env");
const LOCK_FILE = process.env.FCW_LOCK_FILE || join(homedir(), ".local/state/fukuoka-condo-watch/suumo-crawl.lock");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** KEY=VALUE の行だけ読む（シェルとして評価しない）。値は表示しない */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) console.warn(`⚠️ ${path} の権限が ${mode.toString(8)} です。chmod 600 にしてください`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

interface Config {
  ingestUrl: string;
  token: string;
  env: Record<string, string | undefined>;
}

function loadConfig(): Config {
  const env: Record<string, string | undefined> = { ...readEnvFile(ENV_FILE), ...process.env };
  const ingestUrl = env.LISTINGS_INGEST_URL?.trim() ?? "";
  const token = env.LISTINGS_INGEST_TOKEN?.trim() ?? "";
  if (!ingestUrl || !token) {
    console.error(`LISTINGS_INGEST_URL と LISTINGS_INGEST_TOKEN が要ります（${ENV_FILE} か環境変数）`);
    process.exit(1);
  }
  let u: URL;
  try {
    u = new URL(ingestUrl);
  } catch {
    console.error("LISTINGS_INGEST_URL が URL ではありません");
    process.exit(1);
  }
  // トークンを平文で流さない（http はローカルの wrangler dev だけ）
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    console.error("LISTINGS_INGEST_URL は https にしてください（http は localhost だけ）");
    process.exit(1);
  }
  return { ingestUrl: u.toString(), token, env };
}

/**
 * 多重起動よけ（中古・新築で共通）。中身は PID。PID が生きていなければ前回の残骸として取り直す。
 * 生きている別の実行が持っていたら、60 秒おきに見に行って最大 CRAWL.localLockWaitMs 待つ（待ちきれなければ何もせず終わる）
 */
async function acquireLock(): Promise<() => void> {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  const deadline = Date.now() + CRAWL.localLockWaitMs;
  let announced = false;
  for (;;) {
    const r = tryLock();
    if (r.release) return r.release;
    if (Date.now() > deadline) {
      log(`別のクロールが ${Math.round(CRAWL.localLockWaitMs / 3600_000)} 時間たっても終わらない（PID ${r.holder}・${LOCK_FILE}）。今回は何もしない`);
      process.exit(0);
    }
    if (!announced) {
      log(`別のクロールが実行中（PID ${r.holder}）。終わるまで待つ（同時に SUUMO を叩かない）`);
      announced = true;
    }
    await sleep(60_000);
  }
}

function tryLock(): { release?: () => void; holder?: number } {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_FILE, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            unlinkSync(LOCK_FILE);
          } catch {
            /* 既に無い */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) return { holder: pid };
      log(`前回のロックが残っていた（PID ${pid} は終了済み）。取り直す`);
      unlinkSync(LOCK_FILE);
    }
  }
  throw new Error("ロックを取れなかった");
}

/** Worker に送る。通信失敗・5xx は SUUMO に取り直しに行かずに同じ内容を再送する（Worker 側は二重計上しない） */
async function ingest(cfg: Config, body: IngestRequest): Promise<IngestResponse> {
  const waits = [5_000, 30_000, 120_000];
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let text = "";
    try {
      const res = await fetch(cfg.ingestUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      text = await res.text();
      if (res.ok) return JSON.parse(text) as IngestResponse;
      // 4xx は再送しても変わらない（401 = トークン違い、409 = LISTINGS_ENABLED が external でない）
      if (status >= 400 && status < 500) throw new FatalIngestError(`取り込み ${body.op} が HTTP ${status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof FatalIngestError) throw e;
      text = String(e);
    }
    const wait = waits[attempt];
    if (wait === undefined) throw new Error(`取り込み ${body.op} に失敗（HTTP ${status || "-"}）: ${text.slice(0, 300)}`);
    log(`取り込み ${body.op} 失敗（HTTP ${status || "-"}）。${wait / 1000} 秒後に再送`);
    await sleep(wait);
  }
}

class FatalIngestError extends Error {}

/** 種類ごとの取得先（取得・ブロック判定・解析は src/ の同じ部品） */
interface KindSource {
  origin: string;
  pageUrl(target: CrawlTarget, page: number): string;
  fetch(target: CrawlTarget, page: number, url: string): Promise<PageOutcome<AnyListingRecord>>;
}

function sourceFor(kind: CrawlKind, s: ReturnType<typeof crawlSettings>): KindSource {
  const f = (u: string, init: RequestInit) => fetch(u, init);
  if (kind === "shinchiku") {
    const src = new ShinchikuSource({ origin: s.origin, userAgent: s.userAgent });
    return { origin: src.origin, pageUrl: (t, p) => src.pageUrl(t, p), fetch: (t, p, u) => fetchAndClassify(f, src, t, p, u) };
  }
  const src = new SuumoSource({ origin: s.origin, userAgent: s.userAgent, minIntervalMs: s.intervalMs });
  return { origin: src.origin, pageUrl: (t, p) => src.pageUrl(t, p), fetch: (t, p, u) => fetchAndClassify(f, src, t, p, u) };
}

function parseKindArg(): CrawlKind | null {
  const i = process.argv.indexOf("--kind");
  if (i < 0) return "chuko";
  const v = process.argv[i + 1];
  return v === "chuko" || v === "shinchiku" ? v : null;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const kind = parseKindArg();
  if (!kind) {
    console.error("--kind には chuko か shinchiku を");
    return 1;
  }
  const limits = CRAWL_KINDS[kind];
  // --max-pages N: 試し走り用（N ページで切り上げ。続きは次回カーソルから）
  const maxIdx = process.argv.indexOf("--max-pages");
  const maxPages = maxIdx >= 0 ? Number(process.argv[maxIdx + 1]) : limits.localMaxPagesPerRun;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    console.error("--max-pages には 1 以上の整数を");
    return 1;
  }
  const cfg = loadConfig();
  const s = crawlSettings(cfg.env);
  const source = sourceFor(kind, s);
  log(`${limits.label}（${kind}）・取得先 ${source.origin}・間隔 ${s.intervalMs}ms・取り込み先 ${new URL(cfg.ingestUrl).origin}`);
  if (dryRun) {
    log("--dry-run: 設定の確認だけで終わる");
    return 0;
  }

  const release = await acquireLock();
  const started = Date.now();
  let runId: string | undefined;
  let pages = 0;
  let status = "error";
  let detail: string | undefined;
  try {
    // 前回の実行が落ちて lease が残っていると locked。lease（10 分）が切れるまで待って取り直す
    let b = await ingest(cfg, { op: "begin", kind });
    for (let i = 0; b.status === "locked" && i < 12; i++) {
      log("他の実行が lease を持っている（前回が落ちた残りの可能性）。60 秒後に取り直す");
      await sleep(60_000);
      b = await ingest(cfg, { op: "begin", kind });
    }
    runId = b.runId;
    status = b.status ?? "error";
    if (b.status !== "running") {
      log(`今日は取らない: ${b.status}${b.detail ? `（${b.detail}）` : ""}・${b.runId ?? ""}`);
      detail = b.detail;
      return b.status === "locked" ? 1 : 0;
    }
    log(`開始 ${runId}`);

    let lastFetch = b.lastFetchAt ? Date.parse(b.lastFetchAt) : 0;
    let next = b.next ?? null;
    while (next) {
      if (pages >= Math.min(maxPages, limits.localMaxPagesPerRun) || Date.now() - started > limits.localMaxRunMs) {
        detail = `上限（${pages} ページ・${Math.round((Date.now() - started) / 60_000)} 分）で切り上げ。続きは次回`;
        log(detail);
        break;
      }
      const wait = Math.max(0, lastFetch + s.intervalMs - Date.now());
      if (wait > 0) await sleep(wait);

      const target = { areaCode: next.areaCode, key: next.slug };
      const url = source.pageUrl(target, next.page);
      lastFetch = Date.now();
      const fetchedAt = new Date(lastFetch).toISOString();
      const outcome = await source.fetch(target, next.page, url);
      pages++;

      const r = await ingest(cfg, {
        op: "page",
        kind,
        runId: runId!,
        areaCode: next.areaCode,
        page: next.page,
        url,
        fetchedAt,
        // 送る形は Worker 側（parseIngestRequest）が kind に合わせて検証する
        outcome,
      });
      log(`${next.slug} p${next.page}: ${outcome.kind} ${outcomeMessage(outcome)} → ${r.status}${r.stale ? "（反映済みだった）" : ""}`);
      status = r.status ?? "error";
      if (r.status === "blocked") {
        detail = outcomeMessage(outcome);
        log(`⚠️ SUUMO に止められた（${detail}）。打ち切り。Mac 側は 72 時間クールダウン`);
        return 2;
      }
      if (r.status !== "running") {
        detail = r.detail;
        break;
      }
      next = r.next ?? null;
    }
    log(`終了 ${runId}: ${status}・${pages} ページ・${Math.round((Date.now() - started) / 60_000)} 分${detail ? `・${detail}` : ""}`);
    return 0;
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
    console.error(new Date().toISOString(), "クロールが例外で終了:", detail);
    status = "error";
    return 1;
  } finally {
    if (runId) {
      try {
        await ingest(cfg, { op: "end", kind, runId, summary: { status, pages, detail } });
      } catch (e) {
        console.error("終了の記録に失敗:", e instanceof Error ? e.message : String(e));
      }
    }
    release();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

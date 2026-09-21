// SUUMO 掲載の日次クロール（Mac 側）。launchd（ops/launchd/）から毎日 01:00 に 1 回起動する。
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
//   - 多重起動しない（ロックファイル）。1 回の実行は最大 CRAWL.localMaxPagesPerRun ページ・CRAWL.localMaxRunMs まで
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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CRAWL, crawlSettings, fetchAndClassify, type IngestRequest, type IngestResponse, outcomeMessage } from "../src/listing-crawl-core";
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

/** 多重起動よけ。中身は PID。PID が生きていなければ前回の残骸として取り直す */
function acquireLock(): () => void {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_FILE, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* 既に無い */
        }
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
      if (alive) {
        log(`別のクロールが実行中（PID ${pid}・${LOCK_FILE}）。今回は何もしない`);
        process.exit(0);
      }
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

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  // --max-pages N: 試し走り用（N ページで切り上げ。続きは次回カーソルから）
  const maxIdx = process.argv.indexOf("--max-pages");
  const maxPages = maxIdx >= 0 ? Number(process.argv[maxIdx + 1]) : CRAWL.localMaxPagesPerRun;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    console.error("--max-pages には 1 以上の整数を");
    return 1;
  }
  const cfg = loadConfig();
  const s = crawlSettings(cfg.env);
  const source = new SuumoSource({ origin: s.origin, userAgent: s.userAgent, minIntervalMs: s.intervalMs });
  log(`取得先 ${source.origin}・間隔 ${s.intervalMs}ms・取り込み先 ${new URL(cfg.ingestUrl).origin}`);
  if (dryRun) {
    log("--dry-run: 設定の確認だけで終わる");
    return 0;
  }

  const release = acquireLock();
  const started = Date.now();
  let runId: string | undefined;
  let pages = 0;
  let status = "error";
  let detail: string | undefined;
  try {
    // 前回の実行が落ちて lease が残っていると locked。lease（10 分）が切れるまで待って取り直す
    let b = await ingest(cfg, { op: "begin" });
    for (let i = 0; b.status === "locked" && i < 12; i++) {
      log("他の実行が lease を持っている（前回が落ちた残りの可能性）。60 秒後に取り直す");
      await sleep(60_000);
      b = await ingest(cfg, { op: "begin" });
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
      if (pages >= Math.min(maxPages, CRAWL.localMaxPagesPerRun) || Date.now() - started > CRAWL.localMaxRunMs) {
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
      const outcome = await fetchAndClassify((u, init) => fetch(u, init), source, target, next.page, url);
      pages++;

      const r = await ingest(cfg, { op: "page", runId: runId!, areaCode: next.areaCode, page: next.page, url, fetchedAt, outcome });
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
        await ingest(cfg, { op: "end", runId, summary: { status, pages, detail } });
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

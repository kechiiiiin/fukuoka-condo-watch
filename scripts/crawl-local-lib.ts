// Mac 側クローラの共通部品（設定の読み込み・多重起動よけのロック・Worker への取り込み要求）。
// scripts/suumo-crawl-local.ts（一覧の周回）と scripts/suumo-chintai-detail.ts（賃貸の詳細ページ）が使う。
//
// ⚠️ **同じロックファイル**を使うこと（中古・新築・賃貸・ペット・メゾネット・詳細ページの 6 本が
//    同時に SUUMO を叩かないため）。後から起きた方が最大 CRAWL.localLockWaitMs 待つ。
// ⚠️ トークンは表示しない・ログに出さない。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CRAWL, type IngestRequest, type IngestResponse } from "../src/listing-crawl-core";

export const ENV_FILE = process.env.FCW_ENV_FILE || join(homedir(), ".config/fukuoka-condo-watch/env");
export const LOCK_FILE = process.env.FCW_LOCK_FILE || join(homedir(), ".local/state/fukuoka-condo-watch/suumo-crawl.lock");

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** KEY=VALUE の行だけ読む（シェルとして評価しない）。値は表示しない */
export function readEnvFile(path: string): Record<string, string> {
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

export interface Config {
  ingestUrl: string;
  token: string;
  env: Record<string, string | undefined>;
}

export function loadConfig(): Config {
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
 * 多重起動よけ（一覧の周回と詳細ページで共通）。中身は PID。PID が生きていなければ前回の残骸として取り直す。
 * 生きている別の実行が持っていたら、60 秒おきに見に行って最大 CRAWL.localLockWaitMs 待つ（待ちきれなければ何もせず終わる）
 */
export async function acquireLock(): Promise<() => void> {
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

export class FatalIngestError extends Error {}

/** Worker に送る。通信失敗・5xx は SUUMO に取り直しに行かずに同じ内容を再送する（Worker 側は二重計上しない） */
export async function ingest(cfg: Config, body: IngestRequest): Promise<IngestResponse> {
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

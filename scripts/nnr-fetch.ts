// 西鉄の時刻表サイト（jik.nishitetsu.jp）を少量だけ読むための取得口。
// robots.txt で自動取得が断られているサイトなので、次を守る:
//   - 直列・1 件ごとに最低 3 秒あける（並列にしない）
//   - 応答はすべて $TMPDIR/nnr-cache/ にキャッシュし、同じ URL を二度取らない
//   - 総リクエスト数の上限（既定 700）。超えそうなら例外で止める
//   - エラー・空応答が 5 回続いたら止める（再試行の連打をしない）
// curl を使う（サンドボックスのプロキシ設定をそのまま使えるため）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE = "https://jik.nishitetsu.jp/";
export const CACHE_DIR = join(process.env.TMPDIR ?? tmpdir(), "nnr-cache");
const MIN_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 5;

export class LimitReached extends Error {}
export class TooManyFailures extends Error {}

const state = {
  network: 0, // この実行で実際にサイトへ送ったリクエスト数
  cached: 0,
  consecutiveFailures: 0,
  lastAt: 0,
  limit: Number(process.env.NNR_LIMIT ?? 700),
};

/** 過去の実行も含めた累計リクエスト数（キャッシュ内の台帳から数える） */
export function totalRequestsEver(): number {
  const ledger = join(CACHE_DIR, "_requests.log");
  if (!existsSync(ledger)) return 0;
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean).length;
}

export function stats() {
  return { network: state.network, cached: state.cached, totalEver: totalRequestsEver(), limit: state.limit };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function keyOf(method: string, url: string, body: string): string {
  return createHash("sha256").update(`${method} ${url}\n${body}`).digest("hex").slice(0, 32);
}

/** 1 件取る。キャッシュにあればそれを返す。cacheOnly なら取りに行かず null */
export function nnrFetch(path: string, opts: { method?: "GET" | "POST"; body?: string; cacheOnly?: boolean } = {}): string | null {
  const method = opts.method ?? "GET";
  const body = opts.body ?? "";
  const url = path.startsWith("http") ? path : BASE + path.replace(/^\//, "");
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${keyOf(method, url, body)}.txt`);
  if (existsSync(file)) {
    state.cached++;
    return readFileSync(file, "utf8");
  }
  if (opts.cacheOnly) return null;
  if (totalRequestsEver() >= state.limit) throw new LimitReached(`リクエスト上限 ${state.limit} に達しました`);

  const wait = state.lastAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) sleepSync(wait);
  state.lastAt = Date.now();
  state.network++;
  appendFileSync(join(CACHE_DIR, "_requests.log"), `${new Date().toISOString()}\t${method}\t${url}\t${body}\n`);

  const args = ["-sS", "-L", "--max-time", "30", "-A", "Mozilla/5.0 (personal house-hunting; low rate)", "-w", "\n__HTTP_STATUS__%{http_code}"];
  if (method === "POST") args.push("-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded; charset=UTF-8", "--data", body);
  args.push(url);
  let out = "";
  try {
    out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    out = "";
    console.error(`  curl 失敗: ${(e as Error).message.split("\n")[0]}`);
  }
  const m = out.match(/\n__HTTP_STATUS__(\d+)$/);
  const status = m ? Number(m[1]) : 0;
  const text = m ? out.slice(0, m.index) : out;
  if (status !== 200 || text.trim().length === 0) {
    state.consecutiveFailures++;
    console.error(`  失敗 ${status} ${url} ${body}`);
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new TooManyFailures(`エラー・空応答が ${MAX_CONSECUTIVE_FAILURES} 回続いたので止めます`);
    return null; // 失敗はキャッシュしない（次の実行で 1 回だけ取り直す）
  }
  state.consecutiveFailures = 0;
  writeFileSync(file, text);
  return text;
}

/** 数値文字参照・主な実体参照をデコードする */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// 単体で 1 件だけ取って中身を見るとき: node --import tsx scripts/nnr-fetch.ts <path> [postBody]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [p, b] = process.argv.slice(2);
  const t = nnrFetch(p!, b ? { method: "POST", body: b } : {});
  process.stdout.write(t ?? "(null)\n");
  console.error(JSON.stringify(stats()));
}

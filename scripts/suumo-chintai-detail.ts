// 賃貸の詳細ページから「LDK の畳数」を取る（Mac 側）。launchd（ops/launchd/）から毎週土曜 16:00。
// ⚠️ 私的・非商用の個人利用に限る（README「掲載情報（SUUMO）」）。
//
// なぜ詳細ページか: **畳数は一覧に出ない**（2026-09-26 に保存した一覧 6 ページで「畳」の出現が 0 回）。
// 詳細ページ（/chintai/jnc_<掲載 ID>/?bc=<部屋 ID>）の「物件概要」に
//   間取り詳細 … 和6 洋7 洋5.2 LDK16.4
// があり、ここから LDK の畳数が読める（単位の「畳」は書かれていない。src/suumo-chintai.ts の ChintaiDetail）。
//
// 相手への負担を増やさないための決めごと:
//   - **取りに行くのは「全条件を通った最終候補」だけ**（家賃15万以下・70㎡以上・3LDK以上・築25年以内・
//     ペット可・メゾネットでない）。誰を取るかは Worker 側が D1 で選ぶ（src/listing-crawl.ts の detailTargets）
//   - ページ間隔は一覧と同じ 60 秒以上（suumo.jp 相手は CRAWL.floorIntervalMs 未満にできない）
//   - **1 回の実行で CHINTAI_DETAIL_MAX_PER_RUN 件まで**（60 件 ≒ 1 時間）。超えた分は次回へ持ち越し
//   - **取得済み（detail_fetched_at がある）は取り直さない**（畳数が読めなかった部屋も含む）
//   - ロックファイルは一覧の周回と**同じ**（同時に SUUMO を叩かない）
//   - 403 / 429 / 503 / captcha 等を受けたら即打ち切り
//
// 設定は scripts/crawl-local-lib.ts（~/.config/fukuoka-condo-watch/env）と同じ。
//
//   npm run crawl:detail                  # 普段は launchd から
//   npm run crawl:detail -- --dry-run     # 設定の確認だけ（SUUMO にも Worker にもアクセスしない）
//   npm run crawl:detail -- --max 3       # 試し走り（3 件で切り上げ。続きは次回）

import { CHINTAI_DETAIL_MAX_PER_RUN, CRAWL, crawlSettings } from "../src/listing-crawl-core";
import { DEFAULT_USER_AGENT } from "../src/suumo-source";
import { hasChintaiDetailStructure, parseChintaiDetailPage } from "../src/suumo-chintai";
import { detectBlock } from "../src/suumo";
import { acquireLock, type Config, ingest, loadConfig, log, sleep } from "./crawl-local-lib";

const CHINTAI_PATH_PREFIX = "/chintai/";

function numArg(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 1) {
    console.error(`${name} には 1 以上の整数を`);
    process.exit(1);
  }
  return v;
}

interface FetchedDetail {
  externalId: string;
  ldkTatami: number | null;
  /** 止まるべき応答なら種別（403 等）。あれば打ち切る */
  block: string | null;
}

async function fetchDetail(url: string, externalId: string, userAgent: string): Promise<FetchedDetail> {
  let status: number;
  let html: string;
  let location: string | null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "text/html", "accept-language": "ja" },
      redirect: "manual",
      signal: AbortSignal.timeout(CRAWL.fetchTimeoutMs),
    });
    status = res.status;
    location = res.headers.get("location");
    html = await res.text();
  } catch (e) {
    // 通信の失敗は「読めなかった」扱い（次回また取れるよう、結果は送らない）
    log(`${externalId}: fetch 失敗 ${String(e).slice(0, 200)}`);
    return { externalId, ldkTatami: null, block: null };
  }
  const block = detectBlock(status, html, { url, location }, CHINTAI_PATH_PREFIX, hasChintaiDetailStructure);
  if (block) return { externalId, ldkTatami: null, block };
  if (status === 404 || (status >= 300 && status < 400)) {
    // 掲載が消えた。畳数は読めないが「取った」ことにして取り直さない（掲載終了は一覧の周回が付ける）
    log(`${externalId}: HTTP ${status}（掲載が無くなった）`);
    return { externalId, ldkTatami: null, block: null };
  }
  if (status !== 200) {
    log(`${externalId}: HTTP ${status}`);
    return { externalId, ldkTatami: null, block: null };
  }
  const d = parseChintaiDetailPage(html);
  return { externalId, ldkTatami: d.ldkTatami, block: null };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const max = Math.min(numArg("--max", CHINTAI_DETAIL_MAX_PER_RUN), CHINTAI_DETAIL_MAX_PER_RUN);
  const cfg: Config = loadConfig();
  const s = crawlSettings(cfg.env);
  const origin = s.origin ?? "https://suumo.jp";
  const userAgent = s.userAgent ?? DEFAULT_USER_AGENT;
  log(`賃貸の詳細ページ（LDK 畳数）・取得先 ${origin}・間隔 ${s.intervalMs}ms・上限 ${max} 件・取り込み先 ${new URL(cfg.ingestUrl).origin}`);
  if (dryRun) {
    log("--dry-run: 設定の確認だけで終わる");
    return 0;
  }

  const release = await acquireLock();
  try {
    const t = await ingest(cfg, { op: "detail_targets", kind: "chintai", limit: max });
    const targets = t.targets ?? [];
    log(`対象 ${targets.length} 件（未取得の最終候補は全部で ${t.remaining ?? "?"} 件）`);
    if (targets.length === 0) return 0;

    const results: { externalId: string; ldkTatami: number | null }[] = [];
    let lastFetch = 0;
    for (const target of targets) {
      const wait = Math.max(0, lastFetch + s.intervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      lastFetch = Date.now();
      // 偽サーバ相手のときは対象の URL のホストを差し替える（本番では s.origin が undefined なのでそのまま）
      const url = s.origin ? new URL(new URL(target.url).pathname + new URL(target.url).search, s.origin).toString() : target.url;
      const r = await fetchDetail(url, target.externalId, userAgent);
      if (r.block) {
        log(`⚠️ SUUMO に止められた（${r.block}）。打ち切り。ここまでの結果だけ送る`);
        await send(cfg, results);
        return 2;
      }
      results.push({ externalId: r.externalId, ldkTatami: r.ldkTatami });
      log(`${r.externalId}: LDK ${r.ldkTatami === null ? "読めず" : `${r.ldkTatami}畳`}`);
    }
    await send(cfg, results);
    const left = Math.max(0, (t.remaining ?? results.length) - results.length);
    log(`終了: ${results.length} 件${left > 0 ? `・残り ${left} 件は次回へ持ち越し` : ""}`);
    return 0;
  } catch (e) {
    console.error(new Date().toISOString(), "詳細ページの取得が例外で終了:", e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    release();
  }
}

/** まとめて送る（1 件ずつ送らず D1 への書き込みを 1 回にする）。読めなかった部屋も送る = 取り直さない印になる */
async function send(cfg: Config, results: { externalId: string; ldkTatami: number | null }[]): Promise<void> {
  if (results.length === 0) return;
  const r = await ingest(cfg, { op: "detail_results", kind: "chintai", fetchedAt: new Date().toISOString(), results });
  log(`反映 ${r.updated ?? 0} 件`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

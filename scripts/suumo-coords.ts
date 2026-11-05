// 掲載（中古・賃貸）の建物の座標を SUUMO のページから取る（Mac 側）。launchd（ops/launchd/run-suumo-coords.sh）から
// 毎日 09:00〜23:00 の毎正時（16:00 除く）。同じスクリプトが先に国土地理院の仮座標（scripts/gsi-coords.ts）を走らせる。
// ⚠️ 私的・非商用の個人利用に限る（README「掲載情報（SUUMO）」）。
//
// 何に使うか: /listings/picks の「バスで職場・学校へ直通」（直通バス停まで徒歩5分以内）とカードの最寄り直通バス停。
// 住所は丁目までしか無いので、ページの地図の座標を使う（src/listing-coords.ts に在りかの根拠）:
//   中古 … 詳細ページ（listings.url）の initIdo / initKeido
//   賃貸 … 周辺環境ページ（listings.url の jnc_*/ の後ろに kankyo/）の js-gmapData。**詳細ページには座標が無い**ので、
//          LDK 畳数の周回（scripts/suumo-chintai-detail.ts）では一緒に読めない
//
// 相手への負担を増やさないための決めごと（賃貸の詳細ページの周回 scripts/suumo-chintai-detail.ts と同じ）:
//   - ページ間隔は一覧と同じ 60 秒以上（suumo.jp 相手は CRAWL.floorIntervalMs 未満にできない）
//   - **1 回の実行で COORD_MAX_PER_RUN 件まで**（= 詳細ページの周回と同じ 60 件 ≒ 1 時間）。超えた分は次回へ持ち越し
//   - **取得済み（coord_fetched_at がある）は取り直さない**（座標が読めなかった物件も含む）
//   - 誰を取るかは Worker が D1 で選ぶ（掲載中・未取得。**同じ建物（建物名 + 住所）は 1 件だけ**・**賃貸が先**（2026-11-01〜）、
//     その中は条件に近いもの = 60㎡以上・3部屋以上・売買5,500万以下・賃貸18万以下 が先）。取った座標は Worker が同じ建物の
//     他の掲載へ使い回す（src/listing-crawl-core.ts の SHARE_*_COORDS_SQL）。国土地理院の仮座標（scripts/gsi-coords.ts）が
//     入っている掲載も取り直して上書きする
//   - ロックファイルは一覧の周回と**同じ**（同時に SUUMO を叩かない）
//   - 403 / 429 / 503 / captcha / redirect_challenge 等を受けたら即打ち切り、**その日（JST）の残りの回は SUUMO に行かない**
//     （止められた印は crawl-local-lib.ts の COORDS_BLOCK_FILE。日付が変われば自動で再開。止められた回の exit code は 2、
//     スキップした回は 0。例外・通信失敗では印を付けない）。国土地理院の仮座標は SUUMO ではないので止めない
//   - 通信の失敗・5xx は「取った」ことにしない（送らない = 次回また取る）。404 / 転送（掲載が消えた）は null で送る
//
// 設定は scripts/crawl-local-lib.ts（~/.config/fukuoka-condo-watch/env）と同じ。
//
//   npm run crawl:coords                  # 普段は launchd から
//   npm run crawl:coords -- --dry-run     # 設定の確認だけ（SUUMO にも Worker にもアクセスしない）
//   npm run crawl:coords -- --max 3       # 試し走り（3 件で切り上げ。続きは次回）

import { COORD_MAX_PER_RUN, type CoordResult, CRAWL, crawlSettings } from "../src/listing-crawl-core";
import {
  chintaiKankyoUrl,
  hasChintaiKankyoStructure,
  hasSaleDetailStructure,
  type LatLng,
  parseChintaiKankyoCoords,
  parseSaleDetailCoords,
} from "../src/listing-coords";
import { DEFAULT_USER_AGENT } from "../src/suumo-source";
import { detectBlock } from "../src/suumo";
import { acquireLock, blockedToday, type Config, COORDS_BLOCK_FILE, ingest, loadConfig, log, markBlocked, sleep } from "./crawl-local-lib";

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

type Fetched =
  /** 送る（座標が読めた / ページはあったが読めなかった / 掲載が消えた） */
  | { send: true; coords: LatLng | null; note: string }
  /** 送らない（通信失敗・5xx 等。次回また取る） */
  | { send: false; note: string }
  /** 止まるべき応答（403 等）。打ち切る */
  | { block: string };

async function fetchCoords(url: string, kind: "sale" | "rent", userAgent: string): Promise<Fetched> {
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
    return { send: false, note: `fetch 失敗 ${String(e).slice(0, 200)}` };
  }
  const block =
    kind === "sale"
      ? detectBlock(status, html, { url, location }, "/ms/chuko/", hasSaleDetailStructure)
      : detectBlock(status, html, { url, location }, "/chintai/", hasChintaiKankyoStructure);
  if (block) return { block };
  if (status === 404 || status === 410 || (status >= 300 && status < 400)) {
    // 掲載が消えた。座標は読めないが「取った」ことにして取り直さない（掲載終了は一覧の周回が付ける）
    return { send: true, coords: null, note: `HTTP ${status}（掲載が無くなった）` };
  }
  if (status !== 200) return { send: false, note: `HTTP ${status}` };
  const coords = kind === "sale" ? parseSaleDetailCoords(html) : parseChintaiKankyoCoords(html);
  return { send: true, coords, note: coords ? `${coords.lat}, ${coords.lng}` : "座標が読めず" };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const max = Math.min(numArg("--max", COORD_MAX_PER_RUN), COORD_MAX_PER_RUN);
  const cfg: Config = loadConfig();
  const s = crawlSettings(cfg.env);
  const origin = s.origin ?? "https://suumo.jp";
  const userAgent = s.userAgent ?? DEFAULT_USER_AGENT;
  log(`掲載の座標（中古・賃貸）・取得先 ${origin}・間隔 ${s.intervalMs}ms・上限 ${max} 件・取り込み先 ${new URL(cfg.ingestUrl).origin}`);
  if (dryRun) {
    const b = blockedToday();
    if (b) log(`今日は SUUMO に止められている（${b}）。本番ならここで終わる`);
    log("--dry-run: 設定の確認だけで終わる");
    return 0;
  }
  // 今日（JST）すでに SUUMO に止められていたら、Worker にも SUUMO にも行かず終わる（翌日は自動で再開）。--max の試し走りも同じ
  const blocked = blockedToday();
  if (blocked) {
    log(`今日（JST）は SUUMO に止められている（${blocked}）ので、座標の取得は明日まで休む（印: ${COORDS_BLOCK_FILE}・日付が変われば自動で再開）`);
    return 0;
  }

  const release = await acquireLock();
  try {
    const t = await ingest(cfg, { op: "coord_targets", kind: "chuko", limit: max });
    const targets = t.targets ?? [];
    log(
      `対象 ${targets.length} 件（未取得は全部で ${t.remaining ?? "?"} 棟・うち条件に近いもの ${t.remainingPriority ?? "?"} 棟。` +
        `同じ建物へ使い回し ${t.shared ?? 0} 件）`,
    );
    if (targets.length === 0) return 0;

    const results: CoordResult[] = [];
    let lastFetch = 0;
    for (const target of targets) {
      const kind = target.kind === "rent" ? "rent" : "sale";
      const pageUrl = kind === "rent" ? chintaiKankyoUrl(target.url) : target.url;
      if (!pageUrl) {
        // URL の形が想定外（取りに行かない）。null で送って取り直さない
        log(`${target.externalId}: URL の形が想定外（${target.url.slice(0, 120)}）`);
        results.push({ externalId: target.externalId, kind, lat: null, lng: null });
        continue;
      }
      const wait = Math.max(0, lastFetch + s.intervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      lastFetch = Date.now();
      // 偽サーバ相手のときは URL のホストを差し替える（本番では s.origin が undefined なのでそのまま）
      const url = s.origin ? new URL(new URL(pageUrl).pathname + new URL(pageUrl).search, s.origin).toString() : pageUrl;
      const r = await fetchCoords(url, kind, userAgent);
      if ("block" in r) {
        log(`⚠️ SUUMO に止められた（${r.block}）。打ち切り。今日（JST）の残りの回は SUUMO に行かない。ここまでの結果だけ送る`);
        markBlocked(r.block);
        await send(cfg, results);
        return 2;
      }
      log(`${target.externalId}（${kind === "rent" ? "賃貸" : "中古"}${target.priority ? "・条件に近い" : ""}）: ${r.note}${r.send ? "" : "（送らない・次回また取る）"}`);
      if (r.send) results.push({ externalId: target.externalId, kind, lat: r.coords?.lat ?? null, lng: r.coords?.lng ?? null });
    }
    await send(cfg, results);
    const left = Math.max(0, (t.remaining ?? results.length) - results.length);
    log(`終了: ${results.length} 件${left > 0 ? `・残り ${left} 棟は次回へ持ち越し` : ""}`);
    return 0;
  } catch (e) {
    console.error(new Date().toISOString(), "座標の取得が例外で終了:", e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    release();
  }
}

/** まとめて送る（D1 への書き込みを 1 回にする）。読めなかった物件も送る = 取り直さない印になる */
async function send(cfg: Config, results: CoordResult[]): Promise<void> {
  if (results.length === 0) return;
  const r = await ingest(cfg, { op: "coord_results", kind: "chuko", fetchedAt: new Date().toISOString(), results });
  log(`反映 ${r.updated ?? 0} 件・同じ建物へ使い回し ${r.shared ?? 0} 件`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

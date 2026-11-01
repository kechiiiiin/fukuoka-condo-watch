// 掲載のうち住所に番地まであるもの（中古の約 1,000 件）に、国土地理院の住所検索で**仮の座標**を入れる（Mac 側）。
// launchd では ops/launchd/run-suumo-coords.sh が SUUMO の座標（scripts/suumo-coords.ts）の前に走らせる。
//
// なぜ: SUUMO は 1 日約 180 件で止める（redirect_challenge）ので、SUUMO の座標が揃うまでの間を住所から埋める。
// 仮座標（coord_source = 'gsi'）は SUUMO の座標が取れたら上書きされる（src/listing-crawl-core.ts の UPDATE_COORDS_SQL）。
//
// 決めごと:
//   - 相手は Worker が D1 で選ぶ（op: "gsi_targets"。掲載中・座標なし・未試行・住所に番地「数字-数字」あり・同じ建物は 1 件）
//   - 1 秒間隔・1 回 GSI_MAX_PER_RUN（300）件まで
//   - **先頭の結果の title に「番」が含まれるときだけ**採る（src/listing-coords.ts の parseGsiAddressSearch）。
//     丁目止まり・結果なしは null で送る（= 試した印。取り直さない）
//   - 通信の失敗・200 以外・JSON が壊れているときは送らない（次回また試す）
//   - 結果は SEND_EVERY 件ずつ op: "gsi_results" で送る（途中で落ちても送った分は残る）
//   - SUUMO は叩かないので一覧の周回のロックは取らない
//
// 設定は scripts/crawl-local-lib.ts（~/.config/fukuoka-condo-watch/env）と同じ。
//
//   npm run crawl:gsi                                  # 普段は launchd から（run-suumo-coords.sh）
//   npm run crawl:gsi -- --dry-run                     # 設定の確認だけ（国土地理院にも Worker にもアクセスしない）
//   npm run crawl:gsi -- --max 3                       # 試し走り（3 件で切り上げ）
//   npm run crawl:gsi -- --address "福岡県福岡市東区原田４-16-36"   # 住所を 1 件引いて表示するだけ（Worker に送らない・複数可）

import { type CoordResult, GSI_MAX_PER_RUN } from "../src/listing-crawl-core";
import { gsiAddressSearchUrl, type LatLng, parseGsiAddressSearch } from "../src/listing-coords";
import { type Config, ingest, loadConfig, log, sleep } from "./crawl-local-lib";

/** 国土地理院へのリクエスト間隔 */
const INTERVAL_MS = 1_000;
/** 何件ずつ Worker へ送るか */
const SEND_EVERY = 50;
const USER_AGENT = "fukuoka-condo-watch (personal, non-commercial)";

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

/** --address の値（複数可） */
function addressArgs(): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === "--address" && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

type Looked =
  /** 送る（番地まで一致した座標 / 採らなかった = null） */
  | { send: true; coords: LatLng | null; note: string }
  /** 送らない（通信失敗・200 以外・JSON が壊れている。次回また試す） */
  | { send: false; note: string };

async function lookUp(address: string): Promise<Looked> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(gsiAddressSearchUrl(address), {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch (e) {
    return { send: false, note: `fetch 失敗 ${String(e).slice(0, 200)}` };
  }
  if (res.status !== 200) return { send: false, note: `HTTP ${res.status}` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { send: false, note: "JSON が壊れている" };
  }
  const coords = parseGsiAddressSearch(json);
  const first = Array.isArray(json) && json[0] ? (json[0] as { properties?: { title?: unknown } }).properties?.title : undefined;
  const title = typeof first === "string" ? first : "（結果なし）";
  return { send: true, coords, note: coords ? `${coords.lat}, ${coords.lng}（${title}）` : `採らない（${title}）` };
}

async function main(): Promise<number> {
  const only = addressArgs();
  if (only.length > 0) {
    // 住所を引いて表示するだけ（Worker には触らない）
    for (const [i, a] of only.entries()) {
      if (i > 0) await sleep(INTERVAL_MS);
      const r = await lookUp(a);
      log(`${a}: ${r.note}${r.send ? "" : "（送らない）"}`);
    }
    return 0;
  }

  const dryRun = process.argv.includes("--dry-run");
  const max = Math.min(numArg("--max", GSI_MAX_PER_RUN), GSI_MAX_PER_RUN);
  const cfg: Config = loadConfig();
  log(`国土地理院の住所検索で仮座標・間隔 ${INTERVAL_MS}ms・上限 ${max} 件・取り込み先 ${new URL(cfg.ingestUrl).origin}`);
  if (dryRun) {
    log("--dry-run: 設定の確認だけで終わる");
    return 0;
  }

  try {
    const t = await ingest(cfg, { op: "gsi_targets", kind: "chuko", limit: max });
    const targets = t.gsiTargets ?? [];
    log(`対象 ${targets.length} 件（未試行は全部で ${t.remaining ?? "?"} 棟）`);
    let pending: CoordResult[] = [];
    let sent = 0;
    let found = 0;
    for (const [i, target] of targets.entries()) {
      if (i > 0) await sleep(INTERVAL_MS);
      const r = await lookUp(target.address);
      log(`${target.externalId}（${target.kind === "rent" ? "賃貸" : "中古"}）${target.address}: ${r.note}${r.send ? "" : "（送らない・次回また試す）"}`);
      if (!r.send) continue;
      if (r.coords) found++;
      pending.push({ externalId: target.externalId, kind: target.kind, lat: r.coords?.lat ?? null, lng: r.coords?.lng ?? null });
      if (pending.length >= SEND_EVERY) {
        sent += await send(cfg, pending);
        pending = [];
      }
    }
    sent += await send(cfg, pending);
    log(`終了: ${sent} 件を送った（うち座標あり ${found} 件）`);
    return 0;
  } catch (e) {
    console.error(new Date().toISOString(), "国土地理院の仮座標が例外で終了:", e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** まとめて送る。採らなかった物件も送る = 試した印になる（gsi_tried_at） */
async function send(cfg: Config, results: CoordResult[]): Promise<number> {
  if (results.length === 0) return 0;
  const r = await ingest(cfg, { op: "gsi_results", kind: "chuko", fetchedAt: new Date().toISOString(), results });
  log(`反映 ${r.updated ?? 0} 件・同じ建物へ使い回し ${r.shared ?? 0} 件`);
  return results.length;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

// SUUMO 賃貸検索結果（/chintai/<都道府県>/sc_<slug>/・サーバ描画 HTML）のパーサと正規化、ChintaiSource。
//
// ⚠️ 私的・非商用の個人利用に限る（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止）。
//    既定は無効（LISTINGS_ENABLED）。Env・D1 に依存させない（Mac 側クローラ scripts/suumo-crawl-local.ts・テストからも使う）。
//    robots.txt（2026-09-14 取得の保存分）の User-agent: * は `/chintai/bc_*/printout/`・`/chintai/*/__JJ_*`・
//    `/chintai/*/city/?sc[]=`・`/*?*sort=` などを Disallow しているが、`/chintai/<都道府県>/sc_<slug>/` は Disallow していない。
//    **並べ替え（sort）のパラメータは付けないこと**。
//
// 構造は 2026-09-26 に実ページで確認した（福岡市中央区 1・2 ページ目、ペット絞り込み、春日市、久山町。
// 保存 HTML は ~/work/_experiments/listing-probe/chintai/。**リポジトリには入れない**）:
//
//   <div class="pagination_set-hit">734<span>件</span>   … 掲載件数（= 部屋の掲載数。一覧の行数とは一致しない。下の「件数とページ数」）
//   <div class="pagination pagination_set-nav"><ol class="pagination-parts"> … ?page=2 … ?page=8  … 最後のページ番号が出る
//   <div class="cassetteitem">                                        … 建物 1 件（1 ページ 20 件）
//     <div class="cassetteitem_content-title">パークハウス地行浜アベニュー</div>
//     <li class="cassetteitem_detail-col1">福岡県福岡市中央区地行４</li>                    … 所在地
//     <li class="cassetteitem_detail-col2"><div class="cassetteitem_detail-text">地下鉄空港線/唐人町駅 歩8分</div>…</li>
//     <li class="cassetteitem_detail-col3"><div>築26年</div><div>8階建</div></li>      … ⚠️ 直下にテキストが無く子要素の中
//     <table class="cassetteitem_other"><tbody><tr class="js-cassette_link">          … 部屋 1 行（建物あたり 1〜3 行）
//       <td> 4階</td>
//       <span class="cassetteitem_price cassetteitem_price--rent"><span class="…ui-text--bold">16万円</span></span>
//       <span class="cassetteitem_price cassetteitem_price--administration">-</span>
//       <span class="cassetteitem_price cassetteitem_price--deposit">16万円</span>
//       <span class="cassetteitem_price cassetteitem_price--gratuity">32万円</span>
//       <span class="cassetteitem_madori">3LDK</span><span class="cassetteitem_menseki">77m<sup>2</sup></span>
//       <input class="js-clipkey" type="hidden" value="100437646092" />                … 部屋の ID（12 桁。name="bc" と同じ値）
//       <a href="/chintai/jnc_000109723289/?bc=100437646092">詳細を見る</a>              … jnc は掲載の ID。部屋の特定は bc の方
//
// 一覧に**無い**もの（推測で埋めない）:
//   - **ペット相談可**: カードに表記が無い。取るには絞り込み（tc=0401102）を付けた 2 周目が要る（CrawlKind "chintai_pets"）
//   - **掲載日・情報公開日**: 表記が無い。listings.listed_on は賃貸では常に NULL（掲載日数・値下げ追跡は売買だけ）
//     （新着の部屋には `cassetteitem_other-checkbox--newarrival` が付くが、日付ではないので取っていない）
//
// 件数とページ数: 件数表示（734 件）は「掲載の数」で、一覧は建物ごとにまとめて出す（ページ内の注記に
// 「まとめて表示しているため、掲載物件総数と物件一覧に表示されている件数が異なる場合があります」とある）。
// そのため **ページ数は件数 ÷ 1ページ件数では出せない**（734/30 = 25 ページと出るが実際は 8 ページ）。
// ページャの最後の番号が本当の最終ページなので、pageCountFromLinks = true にしてそちらを正にしている。
// 同じ理由で「見えた件数がヒット件数の 85% 未満なら掲載終了を付けない」ルールも賃貸では使えない（listing-crawl.ts の minSeenRatio = 0）。

import type { CrawlTarget, ListingRecord, PagedSource, ParsedListPage } from "./listing-types";
import {
  decodeEntities,
  detectBlock as detectBlockGeneric,
  municipalityCodeFromAddress,
  parseAreaSqm,
  SUUMO_ORIGIN,
  suumoTargets,
  toHalfWidth,
} from "./suumo";
import { DEFAULT_USER_AGENT } from "./suumo-source";

export const CHINTAI_SOURCE_ID = "suumo:chintai";
/** ペット相談可の 2 周目（tc=0401102）。同じ listings の行に pets_allowed = 1 を立てるだけ */
export const CHINTAI_PETS_SOURCE_ID = "suumo:chintai-pets";
/**
 * メゾネットタイプの 3 周目（/nj_113/）。同じ listings の行に maisonette = 1 を立てるだけ（行は増やさない）。
 * 2026-09-26 に実ページのサイドバー（「こだわり条件から探す」）で確認: メゾネットは **tc= のチェックボックスには無く**、
 * `/chintai/fukuoka/sc_<slug>/nj_113/` というパスでしか絞れない（CHINTAI_MAISONETTE_PATH に根拠）。
 */
export const CHINTAI_MAISONETTE_SOURCE_ID = "suumo:chintai-maisonette";
/** 一覧 1 ページの建物数（2026-09-26 の実ページで 20 件）。ページ数の計算には使わない（pageCountFromLinks） */
export const CHINTAI_PAGE_SIZE = 20;
export const CHINTAI_PATH_PREFIX = "/chintai/";

/**
 * 取得時の絞り込み（URL クエリ）。2026-09-26 に実ページで確認（中央区で 734 件・返るのは 3LDK/4LDK・60㎡ 以上）。
 * 福岡都市圏の賃貸は全部で数万件あり、60 秒間隔では終わらないので、
 * 「/listings/picks の既定条件より少し広い範囲」だけを取る。画面側の絞り込みはこの範囲の中で効く。
 *   - cb / ct: 賃料の下限・上限（万円）… 画面の既定 15 万円より広い 20 万円
 *   - mb / mt: 専有面積の下限・上限（㎡）… 画面の既定 70㎡ より広い 60㎡
 *   - md: 間取り（3K=08・3DK=09・3LDK=10・4K=11・4DK=12・4LDK=13・5K以上=14）
 * 築年数（cn）は付けない（画面の「築25年以内」で絞る）。**sort は付けない**（robots.txt が `?*sort=` を Disallow）。
 */
export const CHINTAI_QUERY: readonly [string, string][] = [
  ["cb", "0.0"],
  ["ct", "20.0"],
  ["mb", "60"],
  ["mt", "9999999"],
  ["md", "08"],
  ["md", "09"],
  ["md", "10"],
  ["md", "11"],
  ["md", "12"],
  ["md", "13"],
  ["md", "14"],
];

/** ペット相談可の絞り込み（一覧の絞り込みチェックボックス name="tc" value="0401102"。2026-09-26 に実ページで確認） */
export const CHINTAI_PETS_PARAM: readonly [string, string] = ["tc", "0401102"];

/**
 * メゾネットタイプの絞り込み。**クエリではなくパスの一部**（`/chintai/fukuoka/sc_<slug>/nj_113/`）。
 *
 * 2026-09-26 に実ページ（~/work/_experiments/listing-probe/chintai/chuo_p1.html）で確認した根拠:
 *   - サイドバーに `<a href="/chintai/fukuoka/sc_fukuokashichuo/nj_113/">メゾネットタイプ</a>` がある
 *   - 同じ並びの `nj_103` は「ペット可・相談OK」で、これは絞り込みチェックボックス `tc=0401102` と同じ条件。
 *     つまり nj_* は tc 等の条件の「パス表現」で、値の対応が取れている
 *   - 一覧に出る `name="tc"` のチェックボックスは 12 個（0400101 2階以上住戸 / 0400301 バス・トイレ別 /
 *     0400501 室内洗濯機置場 / 0400503 フローリング / 0400601 エアコン付 / 0400801 オートロック /
 *     0400901 駐車場あり / 0401102 ペット相談 / 0401106 定期借家を含まない / 0401301 間取り図付 /
 *     0401305 物件動画付き / 0401307 パノラマ付き）で、**メゾネットに当たる tc の値はページのどこにも出てこない**
 *   - 保存 HTML 全体で「メゾネット」の出現はこの 1 か所だけ（他に表記が無いので一覧カードからは判定できない）
 *   - robots.txt（2026-09-14 取得の保存分）の Disallow に nj_ で始まるパス（/chintai/<県>/sc_x/nj_NNN/）は無い
 */
export const CHINTAI_MAISONETTE_PATH = "nj_113";

/** 絞り込みの説明（画面の注記に出す） */
export const CHINTAI_QUERY_LABEL = "賃料 20万円以下・専有面積 60㎡以上・間取り 3K〜5K以上（取得時の絞り込み）";

/** 一覧の周回。plain = 1 周目 / pets = ペット相談可（tc=0401102） / maisonette = メゾネットタイプ（nj_113） */
export type ChintaiRound = "plain" | "pets" | "maisonette";

export function chintaiSearchUrl(slug: string, page: number, origin = SUUMO_ORIGIN, round: ChintaiRound = "plain"): string {
  const q = [...CHINTAI_QUERY, ...(round === "pets" ? [CHINTAI_PETS_PARAM] : [])].map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (page > 1) q.push(`page=${page}`);
  // メゾネットだけはクエリではなくパス（nj_113）。賃料・面積・間取りの絞り込みクエリはその上に載せる
  const path = round === "maisonette" ? `sc_${slug}/${CHINTAI_MAISONETTE_PATH}` : `sc_${slug}`;
  return `${origin}/chintai/fukuoka/${path}/?${q.join("&")}`;
}

/** 掲載の詳細ページ（LDK の畳数を取る先）。一覧のリンクと同じ形（/chintai/jnc_<掲載 ID>/?bc=<部屋 ID>） */
export function chintaiDetailUrl(jnc: string, bc: string, origin = SUUMO_ORIGIN): string {
  return `${origin}/chintai/jnc_${jnc}/?bc=${bc}`;
}

// ---------------------------------------------------------------- 正規化

/** "7.3万円" → 73000 / "150000円" → 150000 / "16万円" → 160000 / "-"・"" → null */
export function parseYen(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  const man = /(\d+(?:\.\d+)?)万円?/.exec(s);
  if (man) return Math.round(Number(man[1]) * 10000);
  const yen = /(\d+(?:\.\d+)?)円/.exec(s);
  if (yen) return Math.round(Number(yen[1]));
  return null;
}

/**
 * 管理費・共益費。"5000円" → 5000 / "なし"・"無し"・"込" → 0 / 読めない・空 → null。
 * ⚠️ **"-" は null（不明）にする**。実ページでは管理費が "-" の部屋が多いが、「0 円」なのか「表記なし」なのかは
 * 一覧からは決められない。安い方に倒して断定するより不明のままにする（画面には「不明」と出す）。
 */
export function parseFeeYen(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  if (s === "") return null;
  if (/なし|無し|込|不要/.test(s)) return 0;
  return parseYen(s);
}

/**
 * 敷金・礼金。実ページは "16万円" のような円建てが主。"なし" は 0、**"-" は null（不明）**（管理費と同じ理由）。
 * "1ヶ月"・"2.5ヶ月" のような月数表記も受ける（賃料 × 月数。賃料が分からなければ null）。
 */
export function parseDepositYen(raw: string, rentYen: number | null): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  if (s === "") return null;
  if (/なし|無し|不要/.test(s)) return 0;
  const months = /(\d+(?:\.\d+)?)\s*[ヶヵケか箇]?月/.exec(s);
  if (months && !/円/.test(s)) {
    if (rentYen === null) return null;
    return Math.round(Number(months[1]) * rentYen);
  }
  return parseYen(s);
}

/** "築26年" → 26 / "新築" → 0 / "築1年未満" → 0。読めなければ null */
export function parseBuildingAge(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw));
  if (/新築/.test(s)) return 0;
  const m = /築\s*(\d+)\s*年/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** "8階建" → 8 / "地下1地上14階建" → 14。読めなければ null */
export function parseBuildingFloors(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw));
  const m = /(?:地上)?(\d+)\s*階建/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * 部屋の階の表記（一覧の `<td>`）→ 階数と「室内が 2 層か」。
 *
 * 2026-09-26 の実ページ（中央区 1・2 ページ目／春日市／久山町）に出た表記は
 * "1階"〜"14階"（単独）と **"1-2階"（4 件）** と "-"（不明）だけだった。
 * "1-2階" は**その住戸が 1 階と 2 階の 2 フロアにまたがっている**ということなので、そのままメゾネット（室内 2 層）。
 * 階（floor）は**一番下の階**を入れる（「何階の部屋か」は下の階で言うのが普通）。
 *
 * "-"・空・読めないものは floor = null（不明）。multiLevel は**範囲表記だと分かったときだけ true**にし、
 * 単独表記でも false ではなく「不明ではない（= 1 層）」の意味で false を返す。
 * 地下（"地下1階"）は floor = null（地上何階かではないので数として使わない）。
 */
export function parseRoomFloor(raw: string | null | undefined): { floor: number | null; multiLevel: boolean } {
  const s = toHalfWidth(decodeEntities(raw ?? "")).replace(/\s/g, "");
  if (s === "" || s === "-") return { floor: null, multiLevel: false };
  if (/地下/.test(s)) return { floor: null, multiLevel: false };
  const range = /^(\d+)[-‐－―~〜](\d+)階$/.exec(s);
  if (range) return { floor: Number(range[1]), multiLevel: true };
  const one = /^(\d+)階$/.exec(s);
  if (one) return { floor: Number(one[1]), multiLevel: false };
  return { floor: null, multiLevel: false };
}

/**
 * 賃貸の交通表記 → 路線・駅・徒歩分。実ページは "地下鉄空港線/唐人町駅 歩8分"（中古の「路線「駅」徒歩N分」とは違う）。
 * 「バス」「停歩」を含むものはバス便（徒歩分を駅距離と取り違えない）。駅名末尾の「駅」は落とす。
 */
export function parseChintaiStation(raw: string): { line: string | null; station: string | null; walk: number | null; bus: boolean } {
  const s = toHalfWidth(decodeEntities(raw)).replace(/\s+/g, " ").trim();
  let line: string | null = null;
  let station: string | null = null;
  const q = /^(.*?)「([^」]+)」/.exec(s);
  const sl = /^([^/]+)\/([^\s]+?)(?:\s|歩|徒歩|バス|$)/.exec(s);
  if (q) {
    line = q[1]?.trim() || null;
    station = q[2] ?? null;
  } else if (sl) {
    line = sl[1]?.trim() || null;
    station = sl[2]?.trim() || null;
  }
  if (station) station = station.replace(/駅$/, "") || null;
  const bus = /バス|停歩/.test(s) || (!!line && /^\d+\s*[:：]/.test(line));
  const w = /(?:徒)?歩\s*(\d+)\s*分/.exec(s);
  return { line, station, walk: !bus && w ? Number(w[1]) : null, bus };
}

// ---------------------------------------------------------------- HTML

function textOf(html: string): string {
  return decodeEntities(html.replace(/<sup>2<\/sup>/gi, "2").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * class 属性にトークンを含む要素の中身（最初の 1 つ）。
 * ⚠️ col2・col3 は直下にテキストが無く子要素（div）の中にあるので、タグを剥がしてから読むこと。
 * 入れ子の同じタグ（賃料の span の中の span）は非貪欲に最初の閉じタグで切れるが、textOf でタグを剥がすので値は取れる。
 */
function pickClass(block: string, token: string): string | null {
  const re = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${token}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`);
  const m = re.exec(block);
  return m ? textOf(m[2] ?? "") : null;
}

/** class 属性にトークンを含む要素の中身（すべて） */
function pickClassAll(block: string, token: string): string[] {
  const re = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${token}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`, "g");
  return [...block.matchAll(re)].map((m) => textOf(m[2] ?? "")).filter((s) => s !== "");
}

export interface ChintaiRoom {
  /** 部屋（掲載）の ID。一覧の js-clipkey / name="bc" の 12 桁 */
  externalId: string;
  /** 掲載の詳細ページ（/chintai/jnc_<数字>/?bc=<部屋 ID>） */
  url: string;
  rentYen: number | null;
  /** 管理費・共益費（円/月）。"-" は null（不明） */
  adminFeeYen: number | null;
  depositYen: number | null;
  keyMoneyYen: number | null;
  floorPlan: string | null;
  areaSqm: number | null;
  /** 部屋の階の表記そのまま（"4階"・"1-2階"・"-"） */
  floorText: string | null;
  /** 部屋の階（"4階" → 4・"1-2階" → 1。読めなければ null）。0007 の listings.room_floor */
  roomFloor: number | null;
  /** 室内が 2 層（"1-2階" のような範囲表記）= メゾネット。0007 の listings.maisonette */
  multiLevel: boolean;
}

export interface ChintaiBuilding {
  buildingName: string | null;
  address: string | null;
  municipalityCode: string | null;
  lineName: string | null;
  stationName: string | null;
  walkMinutes: number | null;
  bus: boolean;
  /** 全部の交通表記（参考） */
  traffic: string[];
  buildingAge: number | null;
  buildingYear: number | null;
  /** 建物の階数（"8階建" → 8）。0007 の listings.building_floors */
  buildingFloors: number | null;
  rooms: ChintaiRoom[];
}

export interface ChintaiPage {
  /** 件数表示（= 掲載の数。一覧の行数とは一致しない） */
  totalHits: number | null;
  /** ページャに出ている最大ページ番号。賃貸ではこれが本当の最終ページ */
  maxPageLinked: number | null;
  zeroHits: boolean;
  buildings: ChintaiBuilding[];
}

const ZERO_HITS = /条件にあう物件がありません|該当する物件はありません|物件が見つかりません/;
const BUILDING_START = /<div class="cassetteitem(?:\s[^"]*)?">/g;
const ROOM_START = /<tr class="[^"]*\bjs-cassette_link\b[^"]*">/g;

export function parseChintaiListPage(html: string, fallbackCode: string | null = null, baseYear = new Date().getFullYear()): ChintaiPage {
  const hit = /class="[^"]*\b(?:paginate_set-hit|pagination_set-hit)\b[^"]*"[^>]*>([\s\S]{0,200})/.exec(html);
  let totalHits: number | null = null;
  if (hit) {
    const n = /([\d,]+)\s*(?:<[^>]*>)?\s*件/.exec(hit[1] ?? "");
    if (n && n[1]) totalHits = Number(n[1].replace(/,/g, ""));
  }

  // ページャの番号だけを見る（一覧の他のリンクに page= が出ても拾わないよう、ページャの中に限る）
  let maxPageLinked: number | null = null;
  for (const pager of html.matchAll(/<ol class="pagination-parts">([\s\S]*?)<\/ol>/g)) {
    for (const m of (pager[1] ?? "").matchAll(/[?&](?:amp;)?page=(\d+)|class="pagination-current">\s*(\d+)/g)) {
      const n = Number(m[1] ?? m[2]);
      if (Number.isFinite(n) && (maxPageLinked === null || n > maxPageLinked)) maxPageLinked = n;
    }
  }

  const buildings: ChintaiBuilding[] = [];
  const zeroHits = (totalHits === null || totalHits === 0) && ZERO_HITS.test(html);
  if (zeroHits) return { totalHits: totalHits === 0 ? 0 : null, maxPageLinked, zeroHits: true, buildings };

  const starts = [...html.matchAll(BUILDING_START)].map((m) => m.index ?? 0);
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    const address = pickClass(block, "cassetteitem_detail-col1");
    const traffic = pickClassAll(block, "cassetteitem_detail-text");
    const col3 = pickClass(block, "cassetteitem_detail-col3") ?? "";
    const age = parseBuildingAge(col3);
    const st = parseChintaiStation(traffic[0] ?? "");

    const rooms: ChintaiRoom[] = [];
    const roomStarts = [...block.matchAll(ROOM_START)].map((m) => m.index ?? 0);
    for (let j = 0; j < roomStarts.length; j++) {
      const row = block.slice(roomStarts[j], roomStarts[j + 1] ?? block.length);
      // 部屋の ID は js-clipkey（= name="bc"）の 12 桁。jnc は掲載の ID なのでリンクにだけ使う
      const id =
        /class="js-clipkey"[^>]*value="(\d{6,20})"/.exec(row)?.[1] ??
        /name="bc"[^>]*value="(\d{6,20})"/.exec(row)?.[1] ??
        null;
      const href = /href="(\/chintai\/jnc_\d+\/(?:\?bc=\d+)?)"/.exec(row)?.[1] ?? null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rentYen = parseYen(pickClass(row, "cassetteitem_price--rent") ?? "");
      rooms.push({
        externalId: id,
        url: href ? SUUMO_ORIGIN + href : "",
        rentYen,
        adminFeeYen: parseFeeYen(pickClass(row, "cassetteitem_price--administration") ?? ""),
        depositYen: parseDepositYen(pickClass(row, "cassetteitem_price--deposit") ?? "", rentYen),
        keyMoneyYen: parseDepositYen(pickClass(row, "cassetteitem_price--gratuity") ?? "", rentYen),
        floorPlan: (() => {
          const v = pickClass(row, "cassetteitem_madori");
          return v ? toHalfWidth(v) : null;
        })(),
        areaSqm: parseAreaSqm(pickClass(row, "cassetteitem_menseki") ?? ""),
        ...(() => {
          const floorText = /<td[^>]*>\s*((?:地下)?[\d-]+階)\s*<\/td>/.exec(row)?.[1] ?? null;
          const f = parseRoomFloor(floorText);
          return { floorText, roomFloor: f.floor, multiLevel: f.multiLevel };
        })(),
      });
    }
    if (rooms.length === 0) continue;

    buildings.push({
      buildingName: pickClass(block, "cassetteitem_content-title"),
      address,
      municipalityCode: (address && municipalityCodeFromAddress(address)) || fallbackCode,
      lineName: st.line,
      stationName: st.station,
      walkMinutes: st.walk,
      bus: st.bus,
      traffic,
      buildingAge: age,
      buildingYear: age === null ? null : baseYear - age,
      buildingFloors: parseBuildingFloors(col3),
      rooms,
    });
  }
  return { totalHits, maxPageLinked, zeroHits: false, buildings };
}

/**
 * 1 部屋 → 取り込み用の 1 件（金額は円・price = 月額賃料）。賃料が読めなければ null（捨てる）。
 * petsAllowed はペット絞り込みの 2 周目でだけ true を立てる（1 周目は undefined = 不明のまま）。
 * maisonette も同じで、**3 周目（nj_113）でだけ** true を立てる。
 * ⚠️ 1 周目の階の表記（"1-2階"）からは判定しない（2026-09-26 Keisuke: 判定経路を専用処理の 1 本に絞る）。
 *
 * ⚠️ **パーサが持っている値をここで写し忘れると D1 まで届かない**（2026-09-26 に address で実際に起きた・e1c26b3）。
 *    建物側の値（住所・築年・**階数**）は部屋の行に無いので、全部屋に配ること。
 */
export function toRentListingRecord(
  b: ChintaiBuilding,
  room: ChintaiRoom,
  petsAllowed = false,
  maisonette = false,
): ListingRecord | null {
  if (room.rentYen === null || room.rentYen <= 0) return null;
  const r: ListingRecord = { externalId: room.externalId, kind: "rent", price: room.rentYen };
  if (room.url) r.url = room.url;
  if (b.municipalityCode) r.wardCode = b.municipalityCode;
  // ⚠️ 所在地は**建物側**（cassetteitem_detail-col1）にしかない。部屋の行には無いので、建物の住所を全部屋に配る。
  //    ここを落とすと listings.address が NULL になり、住所から町名を起こす districtNameFromAddress も効かなくなる
  //    （/listings/picks の地区・地区の中古相場との比較が丸ごと外れる）。2026-09-26 の取りこぼしの直し。
  if (b.address) r.address = b.address.slice(0, 300);
  if (b.buildingName) r.buildingName = b.buildingName.slice(0, 300);
  if (b.buildingYear !== null) r.buildingYear = b.buildingYear;
  if (room.areaSqm !== null) r.areaSqm = room.areaSqm;
  if (room.floorPlan) r.floorPlan = room.floorPlan.slice(0, 300);
  if (b.lineName) r.lineName = b.lineName.slice(0, 300);
  if (b.stationName) r.stationName = b.stationName.slice(0, 300);
  if (b.walkMinutes !== null) r.walkMinutes = b.walkMinutes;
  r.bus = b.bus;
  if (room.adminFeeYen !== null) r.adminFee = room.adminFeeYen;
  if (room.depositYen !== null) r.deposit = room.depositYen;
  if (room.keyMoneyYen !== null) r.keyMoney = room.keyMoneyYen;
  if (petsAllowed) r.petsAllowed = true;
  // ⚠️ 階数は**建物側**（cassetteitem_detail-col3）、部屋の階は**部屋の行**（<td>）。どちらも写し忘れると D1 に届かない
  if (b.buildingFloors !== null) r.buildingFloors = b.buildingFloors;
  if (room.roomFloor !== null) r.roomFloor = room.roomFloor;
  // メゾネット: **3 周目（nj_113）で見えた部屋だけ**。
  // ⚠️ 一覧の階が "1-2階"（室内 2 層）でもここでは立てない——判定経路を専用処理の 1 本に絞るため（2026-09-26 Keisuke）。
  // 「メゾネットでない」は入れない（NULL = 不明のまま。取りこぼしで落とさないため）
  if (maisonette) r.maisonette = true;
  return r;
}

// ---------------------------------------------------------------- 詳細ページ（LDK の畳数）

/**
 * 掲載の詳細ページ（/chintai/jnc_<掲載 ID>/?bc=<部屋 ID>）から読める項目。
 *
 * 2026-09-26 に本番で 3 ページ取って確認した（保存先 ~/work/_experiments/listing-probe/chintai/detail/。
 * **リポジトリには入れない**）。要るのは「物件概要」の表（table.data_table.table_gaiyou）の中:
 *
 *   <th class="data_01" scope="cols">間取り詳細</th><td>和6 洋7 洋5.2 LDK16.4</td>
 *   <th class="data_01" scope="cols">階建</th><td>4階/8階建</td>
 *
 * ⚠️ **「畳」という字はページのどこにも出てこない**（一覧も詳細も 0 回）。畳数は「LDK16.4」のように
 *    部屋の種類の直後の数字で書かれている（単位は省略）。和室は「和6」、洋室は「洋7」、納戸は「S」。
 * ⚠️ メゾネットは「特徴」のタグ一覧（読点区切り）に「メゾネット」として出る。
 *    一覧の階が "1階" でもメゾネットのことがある（detail_2_maisonette.html が実例）ので、
 *    一覧の範囲表記だけには頼らない。
 * ⚠️ **管理費・敷金・礼金の "-" は詳細ページでも "-" のまま**（「管理費・共益費:&nbsp;-」）。
 *    詳細ページを取っても「0 円」か「表記なし」かは判別できない（README に記録）。
 */
export interface ChintaiDetail {
  /** 「間取り詳細」の表記そのまま（"和6 洋7 洋5.2 LDK16.4"）。無ければ null */
  layoutDetail: string | null;
  /** LDK（L を含む部屋）の畳数。"LDK16.4" → 16.4。L を含む部屋が無ければ null */
  ldkTatami: number | null;
  /** 部屋の階（"4階/8階建" → 4）。読めなければ null */
  roomFloor: number | null;
  /** 建物の階数（"4階/8階建" → 8・"1階/地上3階建" → 3）。読めなければ null */
  buildingFloors: number | null;
  /** 特徴のタグに「メゾネット」があれば true（無いことは「メゾネットでない」の証拠にはしない） */
  maisonette: boolean;
}

/** 物件概要の表から `<th>見出し</th><td>値</td>` の値を取る */
function gaiyouValue(html: string, header: string): string | null {
  const re = new RegExp(`<th[^>]*>\\s*${header}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]{0,400}?)<\\/td>`);
  const m = re.exec(html);
  if (!m) return null;
  const v = textOf(m[1] ?? "");
  return v === "" || v === "-" ? null : v;
}

/**
 * 「間取り詳細」→ LDK の畳数。
 * 部屋は「和6」「洋7」「LDK16.4」「S3」のように 種類 + 数字 で並ぶ。
 * **L を含む種類（LDK・LD・L・SLDK）の数字**を返す（複数あれば一番大きいもの）。無ければ null。
 */
export function parseLdkTatami(layoutDetail: string | null | undefined): number | null {
  if (!layoutDetail) return null;
  const s = toHalfWidth(decodeEntities(layoutDetail)).toUpperCase();
  let best: number | null = null;
  for (const m of s.matchAll(/([A-Z]{1,4})\s*(\d+(?:\.\d+)?)/g)) {
    const label = m[1] ?? "";
    if (!label.includes("L")) continue;
    const v = Number(m[2]);
    if (!Number.isFinite(v) || v <= 0 || v > 200) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

/** "4階/8階建" → { roomFloor: 4, buildingFloors: 8 } / "1階/地上3階建" → { 1, 3 } */
export function parseDetailFloors(raw: string | null | undefined): { roomFloor: number | null; buildingFloors: number | null } {
  if (!raw) return { roomFloor: null, buildingFloors: null };
  const s = toHalfWidth(decodeEntities(raw));
  const room = parseRoomFloor(/^([^/]*?階)\s*\//.exec(s)?.[1] ?? null);
  return { roomFloor: room.floor, buildingFloors: parseBuildingFloors(s) };
}

export function parseChintaiDetailPage(html: string): ChintaiDetail {
  const layoutDetail = gaiyouValue(html, "間取り詳細");
  const floors = parseDetailFloors(gaiyouValue(html, "階建"));
  return {
    layoutDetail,
    ldkTatami: parseLdkTatami(layoutDetail),
    roomFloor: floors.roomFloor,
    buildingFloors: floors.buildingFloors,
    // 特徴のタグ一覧（読点区切り）に出る。ページ全体で探すと「メゾネットタイプで探す」のような
    // 誘導文言まで拾ってしまうので、**読点の直後で、かつ後ろにカタカナが続かない**ものに限る
    maisonette: /[、,]\s*メゾネット(?![ァ-ヴー])/.test(decodeEntities(html.replace(/<[^>]*>/g, " "))),
  };
}

/** 賃貸の詳細ページらしい構造があるか（captcha・メンテ・構造変更の判定に使う） */
export function hasChintaiDetailStructure(html: string): boolean {
  return /class="[^"]*\btable_gaiyou\b/.test(html) || /間取り詳細/.test(html) || /property_view_note/.test(html);
}

/** 賃貸一覧らしい構造があるか（captcha・メンテ・構造変更の判定に使う） */
export function hasChintaiListStructure(html: string): boolean {
  return (
    /class="[^"]*\bcassetteitem\b/.test(html) ||
    /class="[^"]*\b(?:paginate_set-hit|pagination_set-hit)\b/.test(html) ||
    html.includes('id="js-bukkenList"') ||
    ZERO_HITS.test(html)
  );
}

export interface ChintaiSourceOptions {
  origin?: string;
  userAgent?: string;
  /** true ならペット相談可の絞り込み付き（2 周目）。取れた部屋に pets_allowed = 1 を立てるためだけに使う */
  pets?: boolean;
  /** true ならメゾネットタイプの絞り込み付き（3 周目・nj_113）。取れた部屋に maisonette = 1 を立てるためだけに使う */
  maisonette?: boolean;
}

/**
 * SUUMO 賃貸検索（市区町村ごと）。対象は中古・新築と同じ SUUMO_SLUGS（福岡市 7 区 + 近郊 16 市町）。
 * pets = true はペット相談可の絞り込みを足した 2 周目、maisonette = true はメゾネットの 3 周目（取得元 ID も別）。
 */
export class ChintaiSource implements PagedSource<ListingRecord> {
  readonly id: string;
  readonly permission =
    "私的・非商用の個人利用（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止。許諾契約ではない）。" +
    "robots.txt（2026-09-14 取得）は /chintai/<都道府県>/sc_*/ を Disallow していない（sort パラメータは付けない）。";
  readonly pageSize = CHINTAI_PAGE_SIZE;
  /** 件数からはページ数を出せない（建物ごとにまとめて表示するため）。ページャの最終番号を正とする */
  readonly pageCountFromLinks = true;
  readonly origin: string;
  readonly userAgent: string;
  readonly pets: boolean;
  readonly maisonette: boolean;
  readonly round: ChintaiRound;

  constructor(opts: ChintaiSourceOptions = {}) {
    this.pets = opts.pets ?? false;
    this.maisonette = opts.maisonette ?? false;
    if (this.pets && this.maisonette) throw new Error("pets と maisonette は同時に指定しない（周回は 1 つずつ）");
    this.round = this.pets ? "pets" : this.maisonette ? "maisonette" : "plain";
    this.id = this.pets ? CHINTAI_PETS_SOURCE_ID : this.maisonette ? CHINTAI_MAISONETTE_SOURCE_ID : CHINTAI_SOURCE_ID;
    this.origin = opts.origin ?? SUUMO_ORIGIN;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  targets(): CrawlTarget[] {
    return suumoTargets().map((t) => ({ areaCode: t.code, key: t.slug }));
  }

  pageUrl(target: CrawlTarget, page: number): string {
    return chintaiSearchUrl(target.key, page, this.origin, this.round);
  }

  parsePage(html: string, target: CrawlTarget): ParsedListPage<ListingRecord> {
    const p = parseChintaiListPage(html, target.areaCode);
    const records: ListingRecord[] = [];
    let skipped = 0;
    for (const b of p.buildings) {
      for (const room of b.rooms) {
        const r = toRentListingRecord(b, room, this.pets, this.maisonette);
        if (r) records.push(r);
        else skipped++;
      }
    }
    return { totalHits: p.totalHits, zeroHits: p.zeroHits, maxPageLinked: p.maxPageLinked, records, skipped };
  }

  detectBlock(status: number, html: string, redirect?: { url: string; location: string | null }): string | null {
    return detectBlockGeneric(status, html, redirect, CHINTAI_PATH_PREFIX, hasChintaiListStructure);
  }
}

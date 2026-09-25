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

/** 絞り込みの説明（画面の注記に出す） */
export const CHINTAI_QUERY_LABEL = "賃料 20万円以下・専有面積 60㎡以上・間取り 3K〜5K以上（取得時の絞り込み）";

export function chintaiSearchUrl(slug: string, page: number, origin = SUUMO_ORIGIN, pets = false): string {
  const q = [...CHINTAI_QUERY, ...(pets ? [CHINTAI_PETS_PARAM] : [])].map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (page > 1) q.push(`page=${page}`);
  return `${origin}/chintai/fukuoka/sc_${slug}/?${q.join("&")}`;
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
  /** 部屋の階（"4階"）。参考情報（DB には入れない） */
  floorText: string | null;
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
  /** 建物の階数（参考。DB には入れない） */
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
        floorText: /<td[^>]*>\s*((?:地下)?[\d-]+階)\s*<\/td>/.exec(row)?.[1] ?? null,
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
 */
export function toRentListingRecord(b: ChintaiBuilding, room: ChintaiRoom, petsAllowed = false): ListingRecord | null {
  if (room.rentYen === null || room.rentYen <= 0) return null;
  const r: ListingRecord = { externalId: room.externalId, kind: "rent", price: room.rentYen };
  if (room.url) r.url = room.url;
  if (b.municipalityCode) r.wardCode = b.municipalityCode;
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
  return r;
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
}

/**
 * SUUMO 賃貸検索（市区町村ごと）。対象は中古・新築と同じ SUUMO_SLUGS（福岡市 7 区 + 近郊 16 市町）。
 * pets = true はペット相談可の絞り込みを足した 2 周目（取得元 ID も別）。
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

  constructor(opts: ChintaiSourceOptions = {}) {
    this.pets = opts.pets ?? false;
    this.id = this.pets ? CHINTAI_PETS_SOURCE_ID : CHINTAI_SOURCE_ID;
    this.origin = opts.origin ?? SUUMO_ORIGIN;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  targets(): CrawlTarget[] {
    return suumoTargets().map((t) => ({ areaCode: t.code, key: t.slug }));
  }

  pageUrl(target: CrawlTarget, page: number): string {
    return chintaiSearchUrl(target.key, page, this.origin, this.pets);
  }

  parsePage(html: string, target: CrawlTarget): ParsedListPage<ListingRecord> {
    const p = parseChintaiListPage(html, target.areaCode);
    const records: ListingRecord[] = [];
    let skipped = 0;
    for (const b of p.buildings) {
      for (const room of b.rooms) {
        const r = toRentListingRecord(b, room, this.pets);
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

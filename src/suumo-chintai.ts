// SUUMO 賃貸検索結果（/chintai/<都道府県>/sc_<slug>/・サーバ描画 HTML）のパーサと正規化、ChintaiSource。
//
// ⚠️ 私的・非商用の個人利用に限る（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止）。
//    既定は無効（LISTINGS_ENABLED）。Env・D1 に依存させない（Mac 側クローラ scripts/suumo-crawl-local.ts・テストからも使う）。
//    robots.txt（~/work/_experiments/listing-probe/suumo_robots.txt・2026-09-14 取得）の User-agent: * は
//    `/chintai/bc_*/printout/`・`/chintai/*/__JJ_*`・`/chintai/*/city/?sc[]=`・`/*?*sort=` などを Disallow しているが、
//    `/chintai/<都道府県>/sc_<slug>/` は Disallow していない。**並べ替え（sort）のパラメータは付けないこと**。
//
// ⚠️ 未検証の点（このタスクでは本番 SUUMO に一切アクセスしていない。初回は 1 リクエストずつ確かめること）:
//   1. スラッグが中古・新築（SUUMO_SLUGS）と同じか（/chintai/fukuoka/city/ のリンクと hidden `sc=` で突き合わせる）
//   2. 件数表示のクラス名（`paginate_set-hit` / `pagination_set-hit` の両方を見ている）
//   3. 絞り込みクエリ（CHINTAI_QUERY）のパラメータ名と値の対応
//   4. ペット相談可がどこに出るか（建物・部屋のどちらのブロックに出ても拾えるよう、文言で探している）
//
// 一覧の構造（よく知られた SUUMO 賃貸一覧のマークアップ。建物 1 件 = cassetteitem・その中に部屋が複数行）:
//   <div class="cassetteitem">
//     <div class="cassetteitem_content-title">建物名</div>
//     <li class="cassetteitem_detail-col1">福岡県福岡市中央区…</li>          … 所在地
//     <li class="cassetteitem_detail-col2"><div class="cassetteitem_detail-text">西鉄天神大牟田線/薬院駅 歩5分</div>…</li>
//     <li class="cassetteitem_detail-col3"><div>築15年</div><div>9階建</div></li>
//     <table class="cassetteitem_other"><tr class="js-cassette_link">                 … 部屋 1 行
//       <span class="cassetteitem_price cassetteitem_price--rent">7.3万円</span>
//       <span class="cassetteitem_price cassetteitem_price--administration">5000円</span>
//       <span class="cassetteitem_price cassetteitem_price--deposit">7.3万円</span>
//       <span class="cassetteitem_price cassetteitem_price--gratuity">なし</span>
//       <span class="cassetteitem_madori">3LDK</span><span class="cassetteitem_menseki">72.5m<sup>2</sup></span>
//       <a href="/chintai/jnc_000012345678/?bc=…">詳細を見る</a>                      … 物件 ID は jnc_<数字>
//
// 賃貸は 1 行 = 1 部屋なので、listings の 1 行も 1 部屋（external_id = jnc_…）。
// 金額はすべて円（current_price = 月額賃料）。敷金・礼金が「◯ヶ月」表記のときは賃料 × 月数で円に直す。

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
/** 一覧 1 ページの既定表示件数（建物単位）。件数表示（部屋数）から割るとページ数は多めに出るが、空ページで止まる */
export const CHINTAI_PAGE_SIZE = 30;
export const CHINTAI_PATH_PREFIX = "/chintai/";

/**
 * 取得時の絞り込み（URL クエリ）。福岡都市圏の賃貸は全部で数万件あり、60 秒間隔では 1 週間かかっても終わらないので、
 * 「/listings/picks の既定条件より少し広い範囲」だけを取る。画面側の絞り込みはこの範囲の中で効く。
 *   - ct: 賃料上限（万円）… 画面の既定 15 万円より広い 20 万円
 *   - mb: 専有面積の下限（㎡）… 画面の既定 70㎡ より広い 60㎡
 *   - md: 間取り（3K=08・3DK=09・3LDK=10・4K=11・4DK=12・4LDK=13・5K以上=14）… 画面の「3LDK 以上」＋ DK/K を含めるトグルぶん
 * 築年数（cn）は付けない（画面の「築25年以内」で絞る）。**sort は付けない**（robots.txt が `?*sort=` を Disallow）。
 * ⚠️ パラメータ名と値は 2026-09 時点の SUUMO 賃貸検索 URL の通説に基づく未検証の値。初回に 1 リクエストで件数を確かめること。
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

/** 絞り込みの説明（画面の注記に出す） */
export const CHINTAI_QUERY_LABEL = "賃料 20万円以下・専有面積 60㎡以上・間取り 3K〜5K以上（取得時の絞り込み）";

export function chintaiSearchUrl(slug: string, page: number, origin = SUUMO_ORIGIN): string {
  const q = CHINTAI_QUERY.map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (page > 1) q.push(`page=${page}`);
  return `${origin}/chintai/fukuoka/sc_${slug}/?${q.join("&")}`;
}

// ---------------------------------------------------------------- 正規化

/** "7.3万円" → 73000 / "150000円" → 150000 / "12万円" → 120000 / "-"・"" → null */
export function parseYen(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  const man = /(\d+(?:\.\d+)?)万円?/.exec(s);
  if (man) return Math.round(Number(man[1]) * 10000);
  const yen = /(\d+(?:\.\d+)?)円/.exec(s);
  if (yen) return Math.round(Number(yen[1]));
  return null;
}

/** 管理費・共益費。"5000円" → 5000 / "-"・"なし"・"０円" → 0 / 読めなければ null */
export function parseFeeYen(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  if (s === "" ) return null;
  if (/^[-‐－―ー]+$/.test(s) || /なし|無し|込|不要/.test(s)) return 0;
  return parseYen(s);
}

/**
 * 敷金・礼金。金額表記はそのまま円に、"1ヶ月"・"2.5ヶ月" は賃料 × 月数、"-"・"なし" は 0。
 * 賃料が分からない状態で月数表記だったら null（推測で埋めない）。
 */
export function parseDepositYen(raw: string, rentYen: number | null): number | null {
  const s = toHalfWidth(decodeEntities(raw)).replace(/[,\s]/g, "");
  if (s === "") return null;
  if (/^[-‐－―ー]+$/.test(s) || /なし|無し|不要/.test(s)) return 0;
  const months = /(\d+(?:\.\d+)?)\s*[ヶヵケか箇]?月/.exec(s);
  if (months && !/円/.test(s)) {
    if (rentYen === null) return null;
    return Math.round(Number(months[1]) * rentYen);
  }
  return parseYen(s);
}

/** "築15年" → 15 / "新築" → 0 / "築1年未満" → 0。読めなければ null */
export function parseBuildingAge(raw: string): number | null {
  const s = toHalfWidth(decodeEntities(raw));
  if (/新築/.test(s)) return 0;
  const m = /築\s*(\d+)\s*年/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 賃貸の交通表記 → 路線・駅・徒歩分。"西鉄天神大牟田線/薬院駅 歩5分" の形（中古の「路線「駅」徒歩N分」とは違う）。
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

/**
 * ペット相談可か。一覧のこだわり条件・部屋の備考のどこに出ても拾えるよう、文言で探す。
 * 「ペット不可」「ペット相談不可」は false（「ペット」を含むだけで可と判定しない）。
 */
export function parsePetsAllowed(text: string): boolean {
  const s = toHalfWidth(decodeEntities(text.replace(/<[^>]*>/g, " "))).replace(/\s+/g, "");
  if (/ペット[^。、]{0,4}(不可|不相談|禁止)/.test(s)) return false;
  return /ペット(相談|可|飼育|OK)/i.test(s);
}

/** "2026/9/20" / "2026年9月20日" / "情報公開日:2026/09/20" → "2026-09-20"。読めなければ null */
export function parseListedOn(text: string): string | null {
  const s = toHalfWidth(decodeEntities(text.replace(/<[^>]*>/g, " ")));
  const m = /(20\d{2})\s*[/年\-.]\s*(\d{1,2})\s*[/月\-.]\s*(\d{1,2})/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- HTML

function textOf(html: string): string {
  return decodeEntities(html.replace(/<sup>2<\/sup>/gi, "2").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** class 属性にトークンを含む要素の中身（最初の 1 つ） */
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
  /** jnc_<数字> */
  externalId: string;
  url: string;
  rentYen: number | null;
  adminFeeYen: number | null;
  depositYen: number | null;
  keyMoneyYen: number | null;
  floorPlan: string | null;
  areaSqm: number | null;
  /** 部屋の階（"3階"）。参考情報（DB には入れない） */
  floorText: string | null;
  petsAllowed: boolean;
  listedOn: string | null;
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
  petsAllowed: boolean;
  rooms: ChintaiRoom[];
}

export interface ChintaiPage {
  totalHits: number | null;
  maxPageLinked: number | null;
  zeroHits: boolean;
  buildings: ChintaiBuilding[];
}

const ZERO_HITS = /条件にあう物件がありません|該当する物件はありません|物件が見つかりません/;
const BUILDING_START = /<div class="cassetteitem(?:\s[^"]*)?">/g;
const ROOM_START = /<tr class="[^"]*\bjs-cassette_link\b[^"]*">/g;

/**
 * 賃貸一覧 1 ページを解析する。
 * baseYear は築年数から建築年を出すための基準年（既定は実行時の年）。
 */
export function parseChintaiListPage(html: string, fallbackCode: string | null = null, baseYear = new Date().getFullYear()): ChintaiPage {
  const hit =
    /class="[^"]*\b(?:paginate_set-hit|pagination_set-hit)\b[^"]*">([\s\S]*?)<\/div>/.exec(html) ??
    /該当[^<]{0,8}?([\d,]+)\s*件/.exec(html);
  let totalHits: number | null = null;
  if (hit) {
    const n = /([\d,]+)\s*(?:<[^>]*>)?\s*件/.exec(hit[1] ?? "") ?? /([\d,]+)/.exec(hit[1] ?? "");
    if (n && n[1]) totalHits = Number(n[1].replace(/,/g, ""));
  }

  let maxPageLinked: number | null = null;
  for (const m of html.matchAll(/[?&](?:amp;)?page=(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (maxPageLinked === null || n > maxPageLinked)) maxPageLinked = n;
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
    const col3 = pickClassAll(block, "cassetteitem_detail-col3").join(" ") || pickClass(block, "cassetteitem_detail-col3") || "";
    const age = parseBuildingAge(col3);
    const st = parseChintaiStation(traffic[0] ?? "");
    const buildingPets = parsePetsAllowed(block);

    const rooms: ChintaiRoom[] = [];
    const roomStarts = [...block.matchAll(ROOM_START)].map((m) => m.index ?? 0);
    for (let j = 0; j < roomStarts.length; j++) {
      const row = block.slice(roomStarts[j], roomStarts[j + 1] ?? block.length);
      const link = /href="(\/chintai\/(jnc_\d+)\/[^"]*)"/.exec(row) ?? /href="(\/chintai\/(jnc_\d+)\/?)"/.exec(row);
      if (!link || !link[1] || !link[2]) continue;
      if (seen.has(link[2])) continue;
      seen.add(link[2]);
      const rentYen = parseYen(pickClass(row, "cassetteitem_price--rent") ?? "");
      const floorText = /<td[^>]*>\s*(\d+(?:-\d+)?階)\s*<\/td>/.exec(row)?.[1] ?? null;
      rooms.push({
        externalId: link[2],
        url: SUUMO_ORIGIN + link[1].replace(/\?.*$/, ""),
        rentYen,
        adminFeeYen: parseFeeYen(pickClass(row, "cassetteitem_price--administration") ?? ""),
        depositYen: parseDepositYen(pickClass(row, "cassetteitem_price--deposit") ?? "", rentYen),
        keyMoneyYen: parseDepositYen(pickClass(row, "cassetteitem_price--gratuity") ?? "", rentYen),
        floorPlan: (() => {
          const v = pickClass(row, "cassetteitem_madori");
          return v ? toHalfWidth(v) : null;
        })(),
        areaSqm: parseAreaSqm(pickClass(row, "cassetteitem_menseki") ?? ""),
        floorText,
        petsAllowed: buildingPets || parsePetsAllowed(row),
        listedOn: parseListedOn(row) ?? parseListedOn(block),
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
      petsAllowed: buildingPets,
      rooms,
    });
  }
  return { totalHits, maxPageLinked, zeroHits: false, buildings };
}

/** 1 部屋 → 取り込み用の 1 件（金額は円・price = 月額賃料）。賃料が読めなければ null（捨てる） */
export function toRentListingRecord(b: ChintaiBuilding, room: ChintaiRoom): ListingRecord | null {
  if (room.rentYen === null || room.rentYen <= 0) return null;
  const r: ListingRecord = { externalId: room.externalId, kind: "rent", price: room.rentYen, url: room.url };
  if (b.municipalityCode) r.wardCode = b.municipalityCode;
  if (b.buildingName) r.buildingName = b.buildingName.slice(0, 300);
  if (b.buildingYear !== null) r.buildingYear = b.buildingYear;
  if (room.areaSqm !== null) r.areaSqm = room.areaSqm;
  if (room.floorPlan) r.floorPlan = room.floorPlan.slice(0, 300);
  if (b.lineName) r.lineName = b.lineName.slice(0, 300);
  if (b.stationName) r.stationName = b.stationName.slice(0, 300);
  if (b.walkMinutes !== null) r.walkMinutes = b.walkMinutes;
  r.bus = b.bus;
  if (b.address) r.address = b.address.slice(0, 300);
  if (room.adminFeeYen !== null) r.adminFee = room.adminFeeYen;
  if (room.depositYen !== null) r.deposit = room.depositYen;
  if (room.keyMoneyYen !== null) r.keyMoney = room.keyMoneyYen;
  r.petsAllowed = room.petsAllowed;
  if (room.listedOn) r.listedOn = room.listedOn;
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
}

/** SUUMO 賃貸検索（市区町村ごと）。対象は中古・新築と同じ SUUMO_SLUGS（福岡市 7 区 + 近郊 16 市町） */
export class ChintaiSource implements PagedSource<ListingRecord> {
  readonly id = CHINTAI_SOURCE_ID;
  readonly permission =
    "私的・非商用の個人利用（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止。許諾契約ではない）。" +
    "robots.txt（2026-09-14 取得）は /chintai/<都道府県>/sc_*/ を Disallow していない（sort パラメータは付けない）。";
  readonly pageSize = CHINTAI_PAGE_SIZE;
  readonly origin: string;
  readonly userAgent: string;

  constructor(opts: ChintaiSourceOptions = {}) {
    this.origin = opts.origin ?? SUUMO_ORIGIN;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  targets(): CrawlTarget[] {
    return suumoTargets().map((t) => ({ areaCode: t.code, key: t.slug }));
  }

  pageUrl(target: CrawlTarget, page: number): string {
    return chintaiSearchUrl(target.key, page, this.origin);
  }

  parsePage(html: string, target: CrawlTarget): ParsedListPage<ListingRecord> {
    const p = parseChintaiListPage(html, target.areaCode);
    const records: ListingRecord[] = [];
    let skipped = 0;
    for (const b of p.buildings) {
      for (const room of b.rooms) {
        const r = toRentListingRecord(b, room);
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

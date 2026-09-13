// SUUMO 中古マンション検索結果（サーバ描画 HTML）のパーサと正規化。
//
// ⚠️ 私的・非商用の個人利用に限る（SUUMO 利用規約 第2条・第3条7号）。既定は無効（LISTINGS_ENABLED）。
//    README「掲載情報（SUUMO）」参照。取得間隔・停止条件は src/listing-crawl.ts。
//
// HTMLRewriter は Node（テスト）で動かないので、Workers と Node の両方で動く文字列ベースの軽量パーサにした。
// 1 ページ ≒ 230KB・20 件。正規表現は物件ブロックごとに当てるので O(ページ長)。
//
// 構造（2026-09-14 に sc_chikushino ほかの実ページで確認）:
//   <div class="property_unit ...">                  … 物件 1 件
//     <h2 class="property_unit-title"><a href="/ms/chuko/fukuoka/sc_xxx/nc_21637649/">
//     <dl><dt>販売価格</dt><dd><span class="dottable-value">1790万円</span></dd></dl>
//     <dl><dt>所在地</dt><dd>福岡県筑紫野市二日市南１</dd></dl>
//     <dl><dt>沿線・駅</dt><dd>ＪＲ鹿児島本線「二日市」徒歩7分</dd></dl>
//     <dl><dt>専有面積</dt><dd>62.7m<sup>2</sup>（18.96坪）（壁芯）</dd></dl>
//     <dl><dt>間取り</dt><dd>3LDK</dd></dl> / <dt>築年月</dt><dd>1989年4月</dd>
//   <div class="pagination_set-hit">73<span>件</span></div>

import { AREAS } from "./wards";

export const SUUMO_SOURCE_ID = "suumo:ms-chuko";
export const SUUMO_ORIGIN = "https://suumo.jp";
export const SUUMO_PAGE_SIZE = 20;

/**
 * 市区町村コード → SUUMO の検索 URL のスラッグ（/ms/chuko/fukuoka/sc_<slug>/）。
 * 2026-09-14 に https://suumo.jp/ms/chuko/fukuoka/city/ のリンク（id="js-linkSc<コード下3桁>"）と
 * 各ページの hidden input `sc=<5桁コード>` で突き合わせた。推測で足さないこと。
 * 久山町（40348）は一覧のリンクに出ていなかったが（掲載 0 件のときは一覧から消える模様）、
 * sc_kasuyagunhisayama は HTTP 200・hidden `sc=40348`・「条件にあう物件がありません」を確認済み。
 * 使ったリクエスト: 一覧 1 + 近郊 16 = 17 件（6 秒間隔）。福岡市 7 区は listing-probe（2026-09-14）で確認済み。
 */
export const SUUMO_SLUGS: Record<string, string | null> = {
  "40131": "fukuokashihigashi",
  "40132": "fukuokashihakata",
  "40133": "fukuokashichuo",
  "40134": "fukuokashiminami",
  "40135": "fukuokashinishi",
  "40136": "fukuokashijonan",
  "40137": "fukuokashisawara",
  "40217": "chikushino",
  "40218": "kasuga",
  "40219": "onojo",
  "40221": "dazaifu",
  "40231": "nakagawa",
  "40230": "itoshima",
  "40220": "munakata",
  "40223": "koga",
  "40224": "fukutsu",
  "40341": "kasuyagunumi",
  "40342": "kasuyagunsasaguri",
  "40343": "kasuyagunshime",
  "40344": "kasuyagunsue",
  "40345": "kasuyagunshingu",
  "40348": "kasuyagunhisayama",
  "40349": "kasuyagunkasuya",
};

/** クロール対象の市区町村（スラッグ確認済みのものだけ。AREAS の並び順） */
export function suumoTargets(): { code: string; slug: string }[] {
  return AREAS.flatMap((a) => {
    const slug = SUUMO_SLUGS[a.code];
    return slug ? [{ code: a.code, slug }] : [];
  });
}

export function suumoSearchUrl(slug: string, page: number, origin = SUUMO_ORIGIN): string {
  const base = `${origin}/ms/chuko/fukuoka/sc_${slug}/`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

// ---------------------------------------------------------------- 正規化

/** 全角英数・記号を半角に（ＪＲ → JR、１ → 1） */
export function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/**
 * 価格表記 → 万円（整数）。
 * "1790万円" → 1790 / "1億2000万円" → 12000 / "1億円" → 10000 / "2,980万円" → 2980
 * 幅がある表記（"2980万円～3480万円"）は下限。"価格未定" 等は null。
 */
export function parsePriceMan(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/[,\s]/g, "");
  const m = /(?:(\d+(?:\.\d+)?)億)?(?:(\d+(?:\.\d+)?)万)?円/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const oku = m[1] ? Number(m[1]) : 0;
  const man = m[2] ? Number(m[2]) : 0;
  const v = Math.round(oku * 10000 + man);
  return v > 0 ? v : null;
}

/** "62.7m2（18.96坪）（壁芯）" / "62.7㎡" → 62.7。"〜" 幅は下限 */
export function parseAreaSqm(raw: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(?:m2|m²|㎡|平米)/.exec(toHalfWidth(raw).replace(/,/g, ""));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** "1989年4月" → {year:1989, month:4}。"1989年" → month null */
export function parseBuilt(raw: string): { year: number | null; month: number | null } {
  const m = /(\d{4})年(?:\s*(\d{1,2})月)?/.exec(toHalfWidth(raw));
  if (!m) return { year: null, month: null };
  const month = m[2] ? Number(m[2]) : null;
  return { year: Number(m[1]), month: month && month >= 1 && month <= 12 ? month : null };
}

/**
 * "ＪＲ鹿児島本線「二日市」徒歩7分" → {line:"JR鹿児島本線", station:"二日市", walk:7, bus:false}
 * "西鉄バス「xx」バス10分停歩3分" のようなバス便は walk=null・bus=true（徒歩分を駅距離と取り違えない）。
 */
export function parseStation(raw: string): { line: string | null; station: string | null; walk: number | null; bus: boolean } {
  const s = toHalfWidth(raw).trim();
  const m = /^(.*?)「([^」]+)」/.exec(s);
  const bus = /バス|停歩/.test(s);
  const w = /徒歩\s*(\d+)\s*分/.exec(s);
  return {
    line: m && m[1] ? m[1].trim() || null : null,
    station: m ? (m[2] ?? null) : null,
    walk: !bus && w ? Number(w[1]) : null,
    bus,
  };
}

/** "福岡県筑紫野市二日市南１" → 市区町村コード（AREAS の名前で照合。福岡市は「福岡市◯区」） */
export function municipalityCodeFromAddress(addr: string): string | null {
  // SUUMO は旧字・異体字で書くことがある（「糟屋郡須惠町」）。台帳側の表記に寄せてから照合する
  const s = toHalfWidth(addr).replace(/^福岡県/, "").replace(/糟屋郡/, "粕屋郡").replace(/須惠町/, "須恵町");
  for (const a of AREAS) {
    const prefix = a.group === "city" ? `福岡市${a.name}` : a.name;
    if (s.startsWith(prefix) || s.startsWith(`粕屋郡${a.name}`)) return a.code;
  }
  return null;
}

// ---------------------------------------------------------------- HTML

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

export interface SuumoListing {
  externalId: string;
  url: string;
  buildingName: string | null;
  priceMan: number | null;
  address: string | null;
  municipalityCode: string | null;
  lineName: string | null;
  stationName: string | null;
  walkMinutes: number | null;
  bus: boolean;
  areaSqm: number | null;
  floorPlan: string | null;
  builtYear: number | null;
  builtMonth: number | null;
  /** 生の表記（正規化に失敗したときの調査用。DB には入れない） */
  raw: Record<string, string>;
}

export interface SuumoPage {
  /** 検索条件全体のヒット件数（pagination_set-hit）。見つからなければ null */
  totalHits: number | null;
  listings: SuumoListing[];
  /** ページャに出ている最大ページ番号（無ければ null） */
  maxPageLinked: number | null;
  /** 0 件ページ（「条件にあう物件がありません」）。このとき totalHits は null のまま */
  zeroHits: boolean;
  /** 物件一覧らしい構造があるか（false なら captcha・メンテ・構造変更の疑い） */
  looksLikeListPage: boolean;
}

const ZERO_HITS = /条件にあう物件がありません/;

const UNIT_START = /<div class="property_unit(?:\s[^"]*)?">/g;

export function parseSuumoListPage(html: string, fallbackCode: string | null = null): SuumoPage {
  const hit = /class="pagination_set-hit">\s*([\d,]+)\s*<span>件/.exec(html);
  const totalHits = hit && hit[1] ? Number(hit[1].replace(/,/g, "")) : null;

  let maxPageLinked: number | null = null;
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) {
    const n = Number(m[1]);
    if (maxPageLinked === null || n > maxPageLinked) maxPageLinked = n;
  }

  const starts = [...html.matchAll(UNIT_START)].map((m) => m.index ?? 0);
  const listings: SuumoListing[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    const link = /href="(\/ms\/chuko\/[^"]*?\/nc_(\d+)\/)"/.exec(block);
    if (!link || !link[1] || !link[2]) continue;
    if (seen.has(link[2])) continue;
    seen.add(link[2]);

    const raw: Record<string, string> = {};
    for (const m of block.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
      const k = textOf(m[1] ?? "");
      if (k && !(k in raw)) raw[k] = textOf(m[2] ?? "");
    }
    const st = parseStation(raw["沿線・駅"] ?? "");
    const built = parseBuilt(raw["築年月"] ?? "");
    const address = raw["所在地"] || null;
    listings.push({
      externalId: link[2],
      url: SUUMO_ORIGIN + link[1],
      buildingName: raw["物件名"] || null,
      priceMan: parsePriceMan(raw["販売価格"] ?? raw["価格"] ?? ""),
      address,
      municipalityCode: (address && municipalityCodeFromAddress(address)) || fallbackCode,
      lineName: st.line,
      stationName: st.station,
      walkMinutes: st.walk,
      bus: st.bus,
      areaSqm: parseAreaSqm(raw["専有面積"] ?? ""),
      floorPlan: raw["間取り"] ? toHalfWidth(raw["間取り"]) : null,
      builtYear: built.year,
      builtMonth: built.month,
      raw,
    });
  }

  const zeroHits = totalHits === null && listings.length === 0 && ZERO_HITS.test(html);
  const looksLikeListPage = totalHits !== null || zeroHits || html.includes('id="js-bukkenList"');
  return { totalHits, listings, maxPageLinked, zeroHits, looksLikeListPage };
}

function hasListStructure(html: string): boolean {
  return html.includes('id="js-bukkenList"') || /pagination_set-hit/.test(html) || ZERO_HITS.test(html);
}

export type BlockKind = "http_403" | "http_429" | "http_503" | "captcha" | "unexpected_structure";

/**
 * 「礼儀正しく止まる」べき応答か。止まったら当日のクロールを打ち切り、クールダウンに入る（listing-crawl.ts）。
 * - 403 / 429 / 503 はそのまま
 * - 200 でも captcha・アクセス制限の文言があれば captcha
 * - 200 で一覧の構造（件数表示・js-bukkenList）が無ければ unexpected_structure（構造変更の疑い。取り続けない）
 */
export function detectBlock(status: number, html: string): BlockKind | null {
  if (status === 403) return "http_403";
  if (status === 429) return "http_429";
  if (status === 503) return "http_503";
  if (status !== 200) return null;
  if (/captcha|recaptcha|hcaptcha|cf-challenge|challenge-platform|アクセスが集中|不正なアクセス|アクセスを制限/i.test(html)) {
    // 通常ページにも "recaptcha" の文字列が紛れる可能性があるので、一覧の構造が無いときだけ captcha とみなす
    if (!hasListStructure(html)) return "captcha";
  }
  if (!hasListStructure(html)) return "unexpected_structure";
  return null;
}

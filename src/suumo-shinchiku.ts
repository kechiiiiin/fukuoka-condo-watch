// SUUMO 新築マンション検索結果（/ms/shinchiku/・サーバ描画 HTML）のパーサと正規化、ShinchikuSource。
// ⚠️ 私的・非商用の個人利用に限る（README「掲載情報（SUUMO）」）。Env・D1 に依存させない（Mac 側クローラ・テストからも使う）。
//
// 構造（2026-09-22 に sc_fukuokashichuo・sc_kasuga・sc_munakata（0 件）の実ページで確認。~/work/_experiments/listing-probe/shinchiku/）:
//   <div class="hitbox-number">26<span class="hitbox-item">件</span></div>      … 件数（1 ページ 30 件が既定）
//   <div class="sortbox_pagination"> … <a href="/ms/shinchiku/fukuoka/sc_xxx/?page=3&pc=10">
//   <div class="cassette property_unit">                                           … 1 件
//     <input class="js-keisaiKbn" type="hidden" value="4" />                         … 3/4 = 分譲の物件単位・8 = 住戸単位の掲載
//     <a href="/ms/shinchiku/fukuoka/sc_xxx/nc_67736890/" class="cassette_header-title ...">物件名</a>
//     <p class="cassette_basic-title">所在地</p><p class="cassette_basic-value">福岡市中央区大宮２</p>
//       … 交通「西鉄天神大牟田線/西鉄平尾 徒歩5分」・引渡時期「2028年7月下旬予定」「即引渡可」「相談」
//     <li class="cassette_price-list_item">                                          … 販売期ごとに 1 つ（複数あり）
//       <span class="cassette_price-accent">6590万円～1億2190万円</span>&nbsp;（先着順）
//       <p class="cassette_price-description">2LDK・3LDK / 56.85m<sup>2</sup>～81.84m<sup>2</sup></p>
//     <li class="cassette_plantable-list_item"> … 間取りタイプ（最大 3 つ。価格と面積の組）
//       <p class="cassette_plantable-price">6590万円</p><p class="cassette_plantable-layout">2LDK…&nbsp;/&nbsp;56.85m<sup>2</sup></p>
//   0 件の市区町村は「条件にあう物件がありません」＋「◯◯に近い新築分譲マンション」として**他の市区町村の物件**が並ぶ
//   （同じ property_unit の形）。件数表示が無く 0 件文言があるページは物件を読まない。
//
// 一覧に無いもの: 販売戸数・完成時期（詳細ページにしか無い）。取るなら 1 物件 1 リクエスト増える（README「決めていないこと」）。

import type { CrawlTarget, NewListingRecord, PagedSource, ParsedListPage } from "./listing-types";
import { decodeEntities, detectBlock, municipalityCodeFromAddress, parsePriceMan, SUUMO_ORIGIN, suumoTargets, toHalfWidth } from "./suumo";
import { DEFAULT_USER_AGENT } from "./suumo-source";

export const SHINCHIKU_SOURCE_ID = "suumo:ms-shinchiku";
/** 1 ページの既定件数（表示件数の既定が 30 件。pc パラメータは付けない） */
export const SHINCHIKU_PAGE_SIZE = 30;
export const SHINCHIKU_PATH_PREFIX = "/ms/shinchiku/";

export function shinchikuSearchUrl(slug: string, page: number, origin = SUUMO_ORIGIN): string {
  const base = `${origin}/ms/shinchiku/fukuoka/sc_${slug}/`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

// ---------------------------------------------------------------- 正規化

export interface PriceRange {
  /** 万円 */
  min: number | null;
  max: number | null;
  undecided: boolean;
  tentative: boolean;
}

/**
 * 価格表記 → 万円の幅。
 * "6590万円～1億2190万円" → 6590〜12190 / "3720万円・3930万円" → 3720〜3930 / "9880万円" → 9880〜9880
 * "3800万円台・5500万円台／予定" → 3800〜5500（tentative）/ "価格未定" → null（undecided）
 */
export function parsePriceRangeMan(raw: string): PriceRange {
  // 桁区切りのカンマ（"4,360万円"）は先に落とす（区切り記号として扱わない）
  const s = toHalfWidth(decodeEntities(raw)).replace(/[\s,]/g, "");
  const tentative = /予定|万円台/.test(s);
  if (/未定/.test(s)) return { min: null, max: null, undecided: true, tentative };
  const values = s
    .split(/[～〜~・/／、]/)
    .map((t) => parsePriceMan(t))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return { min: null, max: null, undecided: false, tentative };
  return { min: Math.min(...values), max: Math.max(...values), undecided: false, tentative };
}

/** "45.59m2～111.59m2" / "65.19m2・110.21m2" / "43.76m2（13.23坪）（壁芯）" → ㎡ の幅（坪は拾わない） */
export function parseAreaRange(raw: string): { min: number | null; max: number | null } {
  const s = toHalfWidth(decodeEntities(raw.replace(/<sup>2<\/sup>/gi, "2"))).replace(/,/g, "");
  const values = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(?:m2|m²|㎡|平米)/g)].map((m) => Number(m[1])).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * 引渡時期 → "YYYY-MM"。"2028年7月下旬予定" → 2028-07 / "2027年5月予定" → 2027-05 / "即引渡可" → immediate / "相談" → null
 * "2028年3月末予定"・"2027年春" のような年だけのものは ym なし
 */
export function parseDelivery(raw: string): { ym: string | null; immediate: boolean } {
  const s = toHalfWidth(raw);
  const immediate = /即/.test(s);
  const m = /(\d{4})年\s*(\d{1,2})月/.exec(s);
  if (!m) return { ym: null, immediate };
  const month = Number(m[2]);
  if (month < 1 || month > 12) return { ym: null, immediate };
  return { ym: `${m[1]}-${String(month).padStart(2, "0")}`, immediate };
}

/**
 * 交通 → 路線・駅・徒歩。新築は「路線/駅 徒歩N分」（中古の「路線「駅」徒歩N分」とは違う）。
 * "西鉄バス/横手一丁目 徒歩3分" のようなバス停・「バス◯分」は bus（徒歩分は入れない）。
 */
export function parseShinchikuStation(raw: string): { line: string | null; station: string | null; walk: number | null; bus: boolean } {
  const s = toHalfWidth(raw).replace(/\s+/g, " ").trim();
  let line: string | null = null;
  let station: string | null = null;
  const q = /^(.*?)「([^」]+)」/.exec(s);
  const sl = /^([^/]+)\/(\S+?)(?:\s|徒歩|バス|$)/.exec(s);
  if (q) {
    line = q[1]?.trim() || null;
    station = q[2] ?? null;
  } else if (sl) {
    line = sl[1]?.trim() || null;
    station = sl[2]?.trim() || null;
  }
  const bus = /バス|停歩/.test(s) || (!!line && /^\d+\s*[:：]/.test(line));
  const w = /徒歩\s*(\d+)\s*分/.exec(s);
  return { line, station, walk: !bus && w ? Number(w[1]) : null, bus };
}

// ---------------------------------------------------------------- HTML

function textOf(html: string): string {
  return decodeEntities(html.replace(/<sup>2<\/sup>/gi, "2").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface ShinchikuPriceItem {
  price: PriceRange;
  /** （先着順）（東街区 第7期）などの括弧の中 */
  label: string | null;
  plans: string | null;
  area: { min: number | null; max: number | null };
}

export interface ShinchikuListing {
  externalId: string;
  url: string;
  keisaiKbn: string | null;
  listingType: "project" | "unit";
  buildingName: string | null;
  address: string | null;
  municipalityCode: string | null;
  traffic: string | null;
  lineName: string | null;
  stationName: string | null;
  walkMinutes: number | null;
  bus: boolean;
  deliveryText: string | null;
  deliveryYm: string | null;
  deliveryImmediate: boolean;
  priceItems: ShinchikuPriceItem[];
  /** 間取りタイプ（価格と面積の組）。万円・㎡ */
  planUnits: { priceMin: number; priceMax: number; area: number }[];
  /** 生の表記（調査用。DB には入れない） */
  basics: Record<string, string>;
}

export interface ShinchikuPage {
  totalHits: number | null;
  listings: ShinchikuListing[];
  maxPageLinked: number | null;
  zeroHits: boolean;
}

const ZERO_HITS = /条件にあう物件がありません/;
const UNIT_START = /<div class="cassette property_unit(?:\s[^"]*)?">/g;
/** 0 件ページの「◯◯に近い新築分譲マンション」（他の市区町村の物件）。ここから後ろは読まない */
const NEARBY_HEADER = /に近い新築分譲マンション\s*<\/h2>/;

export function parseShinchikuListPage(html: string, fallbackCode: string | null = null): ShinchikuPage {
  const hit = /class="hitbox-number">\s*([\d,]+)\s*<span[^>]*>件/.exec(html);
  const totalHits = hit && hit[1] ? Number(hit[1].replace(/,/g, "")) : null;
  const zeroHits = totalHits === null && ZERO_HITS.test(html);

  let maxPageLinked: number | null = null;
  for (const pager of html.matchAll(/<div class="sortbox_pagination">([\s\S]*?)<\/div>/g)) {
    const body = pager[1] ?? "";
    for (const m of body.matchAll(/[?&](?:amp;)?page=(\d+)|sortbox_pagination--current">\s*(\d+)/g)) {
      const n = Number(m[1] ?? m[2]);
      if (Number.isFinite(n) && (maxPageLinked === null || n > maxPageLinked)) maxPageLinked = n;
    }
  }

  const listings: ShinchikuListing[] = [];
  if (zeroHits) return { totalHits, listings, maxPageLinked, zeroHits };

  const nearby = NEARBY_HEADER.exec(html);
  const scan = nearby ? html.slice(0, nearby.index) : html;
  const starts = [...scan.matchAll(UNIT_START)].map((m) => m.index ?? 0);
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const block = scan.slice(starts[i], starts[i + 1] ?? scan.length);
    const link = /href="(\/ms\/shinchiku\/[^"]*?\/nc_(\d+)\/)"[^>]*class="cassette_header-title/.exec(block) ?? /href="(\/ms\/shinchiku\/[^"?#]*?\/nc_(\d+)\/)"/.exec(block);
    if (!link || !link[1] || !link[2]) continue;
    if (seen.has(link[2])) continue;
    seen.add(link[2]);

    const title = /class="cassette_header-title[^"]*">([\s\S]*?)<\/a>/.exec(block);
    const kbn = /class="js-keisaiKbn" type="hidden" value="(\d+)"/.exec(block)?.[1] ?? null;
    const basics: Record<string, string> = {};
    for (const m of block.matchAll(/class="cassette_basic-title">([\s\S]*?)<\/p>\s*<p class="cassette_basic-value">([\s\S]*?)<\/p>/g)) {
      const k = textOf(m[1] ?? "");
      if (k && !(k in basics)) basics[k] = textOf(m[2] ?? "");
    }
    const priceItems: ShinchikuPriceItem[] = [];
    for (const m of block.matchAll(/<li class="cassette_price-list_item">([\s\S]*?)<\/li>/g)) {
      const item = m[1] ?? "";
      const accent = /class="cassette_price-accent">([\s\S]*?)<\/span>([\s\S]*?)<\/div>/.exec(item);
      if (!accent) continue;
      const label = /（([^）]*)）/.exec(textOf(accent[2] ?? ""))?.[1]?.trim() || null;
      const desc = textOf(/class="cassette_price-description">([\s\S]*?)<\/p>/.exec(item)?.[1] ?? "");
      const slash = desc.indexOf(" / ");
      priceItems.push({
        price: parsePriceRangeMan(textOf(accent[1] ?? "")),
        label,
        plans: slash >= 0 ? toHalfWidth(desc.slice(0, slash)).trim() || null : null,
        area: parseAreaRange(slash >= 0 ? desc.slice(slash + 3) : desc),
      });
    }
    const planUnits: ShinchikuListing["planUnits"] = [];
    for (const m of block.matchAll(/class="cassette_plantable-price">([\s\S]*?)<\/p>\s*<p class="cassette_plantable-layout">([\s\S]*?)<\/p>/g)) {
      const p = parsePriceRangeMan(textOf(m[1] ?? ""));
      const a = parseAreaRange(textOf(m[2] ?? ""));
      if (p.min !== null && p.max !== null && a.min !== null) planUnits.push({ priceMin: p.min, priceMax: p.max, area: a.min });
    }

    const address = basics["所在地"] || null;
    const traffic = basics["交通"] || null;
    const st = parseShinchikuStation(traffic ?? "");
    const deliveryText = basics["引渡時期"] || basics["引渡可能時期"] || basics["入居時期"] || null;
    const dv = parseDelivery(deliveryText ?? "");
    listings.push({
      externalId: link[2],
      url: SUUMO_ORIGIN + link[1],
      keisaiKbn: kbn,
      listingType: kbn === "8" ? "unit" : "project",
      buildingName: title ? textOf(title[1] ?? "") || null : null,
      address,
      municipalityCode: (address && municipalityCodeFromAddress(address)) || fallbackCode,
      traffic,
      lineName: st.line,
      stationName: st.station,
      walkMinutes: st.walk,
      bus: st.bus,
      deliveryText,
      deliveryYm: dv.ym,
      deliveryImmediate: dv.immediate,
      priceItems,
      planUnits,
      basics,
    });
  }
  return { totalHits, listings, maxPageLinked, zeroHits };
}

/** 販売状況の分類（表記は saleLabel にそのまま残す） */
export function classifySaleStatus(l: Pick<ShinchikuListing, "listingType" | "priceItems">): string {
  if (l.listingType === "unit") return "unit";
  const labels = l.priceItems.map((p) => p.label ?? "").join(" ");
  if (/先着/.test(labels)) return "first_come";
  if (/最終期/.test(labels)) return "final";
  if (/第\s*\d+\s*期|期/.test(labels)) return "phase";
  if (/予告/.test(labels)) return "upcoming";
  if (l.priceItems.length > 0 && l.priceItems.every((p) => p.price.undecided || p.price.min === null)) return "upcoming";
  return l.priceItems.some((p) => p.price.min !== null) ? "selling" : "other";
}

export const SALE_STATUS_LABEL: Record<string, string> = {
  first_come: "先着順",
  phase: "期分け販売",
  final: "最終期",
  upcoming: "販売予定（価格未定）",
  selling: "販売中",
  unit: "住戸の掲載",
  other: "不明",
};

const round = (v: number) => Math.round(v);

/** 解析結果 → 取り込み用の 1 件（金額は円・㎡単価は円/㎡） */
export function toNewListingRecord(l: ShinchikuListing): NewListingRecord {
  const priced = l.priceItems.filter((p) => p.price.min !== null && p.price.max !== null);
  const priceMinMan = priced.length ? Math.min(...priced.map((p) => p.price.min!)) : null;
  const priceMaxMan = priced.length ? Math.max(...priced.map((p) => p.price.max!)) : null;
  const areas = l.priceItems.flatMap((p) => [p.area.min, p.area.max]).filter((v): v is number => v !== null);
  const areaMin = areas.length ? Math.min(...areas) : null;
  const areaMax = areas.length ? Math.max(...areas) : null;

  // ㎡単価: 間取りタイプ（価格と面積の組）があればその範囲。無ければ 価格下限/面積下限〜価格上限/面積上限（組が分からないので目安）
  let unitMin: number | null = null;
  let unitMax: number | null = null;
  if (l.planUnits.length) {
    const u = l.planUnits.flatMap((p) => [(p.priceMin * 10000) / p.area, (p.priceMax * 10000) / p.area]);
    unitMin = Math.min(...u);
    unitMax = Math.max(...u);
  } else if (priceMinMan !== null && priceMaxMan !== null && areaMin && areaMax) {
    const a = (priceMinMan * 10000) / areaMin;
    const b = (priceMaxMan * 10000) / areaMax;
    unitMin = Math.min(a, b);
    unitMax = Math.max(a, b);
  }
  const plans = [...new Set(l.priceItems.map((p) => p.plans).filter((v): v is string => !!v))].join(" / ");
  const labels = l.priceItems.map((p) => p.label).filter((v): v is string => !!v);

  const r: NewListingRecord = { externalId: l.externalId, listingType: l.listingType, url: l.url };
  if (l.municipalityCode) r.wardCode = l.municipalityCode;
  if (l.buildingName) r.buildingName = l.buildingName.slice(0, 300);
  if (l.address) r.address = l.address.slice(0, 300);
  if (l.lineName) r.lineName = l.lineName.slice(0, 300);
  if (l.stationName) r.stationName = l.stationName.slice(0, 300);
  if (l.walkMinutes !== null) r.walkMinutes = l.walkMinutes;
  r.bus = l.bus;
  if (priceMinMan !== null) r.priceMin = priceMinMan * 10000;
  if (priceMaxMan !== null) r.priceMax = priceMaxMan * 10000;
  r.priceUndecided = l.priceItems.length === 0 || l.priceItems.some((p) => p.price.undecided || p.price.min === null);
  r.priceTentative = l.priceItems.some((p) => p.price.tentative);
  if (areaMin !== null) r.areaMin = areaMin;
  if (areaMax !== null) r.areaMax = areaMax;
  if (unitMin !== null) r.unitPriceMin = round(unitMin);
  if (unitMax !== null) r.unitPriceMax = round(unitMax);
  if (plans) r.floorPlans = plans.slice(0, 300);
  r.saleStatus = classifySaleStatus(l);
  if (labels.length) r.saleLabel = labels.join(" / ").slice(0, 300);
  if (l.deliveryText) r.deliveryText = l.deliveryText.slice(0, 300);
  if (l.deliveryYm) r.deliveryYm = l.deliveryYm;
  r.deliveryImmediate = l.deliveryImmediate;
  return r;
}

export interface ShinchikuSourceOptions {
  origin?: string;
  userAgent?: string;
}

/** 新築マンション検索（市区町村ごと）。中古（SuumoSource）と同じスラッグ（2026-09-22 に /ms/shinchiku/fukuoka/city/ のリンクで一致を確認） */
export class ShinchikuSource implements PagedSource<NewListingRecord> {
  readonly id = SHINCHIKU_SOURCE_ID;
  readonly pageSize = SHINCHIKU_PAGE_SIZE;
  readonly origin: string;
  readonly userAgent: string;

  constructor(opts: ShinchikuSourceOptions = {}) {
    this.origin = opts.origin ?? SUUMO_ORIGIN;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  targets(): CrawlTarget[] {
    return suumoTargets().map((t) => ({ areaCode: t.code, key: t.slug }));
  }

  pageUrl(target: CrawlTarget, page: number): string {
    return shinchikuSearchUrl(target.key, page, this.origin);
  }

  parsePage(html: string, target: CrawlTarget): ParsedListPage<NewListingRecord> {
    const p = parseShinchikuListPage(html, target.areaCode);
    return {
      totalHits: p.totalHits,
      zeroHits: p.zeroHits,
      maxPageLinked: p.maxPageLinked,
      records: p.listings.map(toNewListingRecord),
      skipped: 0,
    };
  }

  detectBlock(status: number, html: string, redirect?: { url: string; location: string | null }): string | null {
    return detectBlock(status, html, redirect, SHINCHIKU_PATH_PREFIX);
  }
}

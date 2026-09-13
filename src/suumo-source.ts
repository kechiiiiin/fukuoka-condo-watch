// SuumoSource: SUUMO 中古マンション検索（市区町村ごと）を ListingSource / PagedListingSource として包む。
// ⚠️ 私的・非商用の個人利用に限る。既定は無効（LISTINGS_ENABLED）。日次の取り方は src/listing-crawl.ts。

import type { Env } from "./env";
import type { CrawlTarget, ListingRecord, PagedListingSource, ParsedListPage } from "./listing";
import {
  detectBlock,
  parseSuumoListPage,
  SUUMO_ORIGIN,
  SUUMO_PAGE_SIZE,
  SUUMO_SOURCE_ID,
  suumoSearchUrl,
  suumoTargets,
  type SuumoListing,
} from "./suumo";

/** 正直に名乗る（ブラウザを装わない）。LISTINGS_USER_AGENT で上書きできる */
export const DEFAULT_USER_AGENT =
  "fukuoka-condo-watch/1.0 (personal, non-commercial; 1 req per 6s; +https://github.com/kechiiiiin/fukuoka-condo-watch)";

export function toListingRecord(l: SuumoListing): ListingRecord | null {
  if (l.priceMan === null) return null;
  return {
    externalId: l.externalId,
    kind: "sale",
    wardCode: l.municipalityCode ?? undefined,
    buildingName: l.buildingName ?? undefined,
    buildingYear: l.builtYear ?? undefined,
    builtMonth: l.builtMonth ?? undefined,
    areaSqm: l.areaSqm ?? undefined,
    floorPlan: l.floorPlan ?? undefined,
    lineName: l.lineName ?? undefined,
    stationName: l.stationName ?? undefined,
    walkMinutes: l.walkMinutes ?? undefined,
    bus: l.bus,
    address: l.address ?? undefined,
    url: l.url,
    price: l.priceMan * 10000,
  };
}

export class BlockedError extends Error {
  constructor(
    readonly kind: string,
    readonly url: string,
  ) {
    super(`SUUMO が取得を拒否した可能性（${kind}）: ${url}`);
  }
}

export interface SuumoSourceOptions {
  /** テスト用の偽サーバ（http://127.0.0.1:port）。本番は既定の https://suumo.jp */
  origin?: string;
  userAgent?: string;
  minIntervalMs?: number;
}

export class SuumoSource implements PagedListingSource {
  readonly id = SUUMO_SOURCE_ID;
  readonly permission =
    "私的・非商用の個人利用（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止。許諾契約ではない）。" +
    "robots.txt（2026-09-14）は /ms/chuko/ を Disallow していない。";
  readonly pageSize = SUUMO_PAGE_SIZE;
  readonly origin: string;
  readonly userAgent: string;
  readonly minIntervalMs: number;

  constructor(opts: SuumoSourceOptions = {}) {
    this.origin = opts.origin ?? SUUMO_ORIGIN;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.minIntervalMs = opts.minIntervalMs ?? 6000;
  }

  targets(): CrawlTarget[] {
    return suumoTargets().map((t) => ({ areaCode: t.code, key: t.slug }));
  }

  pageUrl(target: CrawlTarget, page: number): string {
    return suumoSearchUrl(target.key, page, this.origin);
  }

  parsePage(html: string, target: CrawlTarget): ParsedListPage {
    const p = parseSuumoListPage(html, target.areaCode);
    const records: ListingRecord[] = [];
    for (const l of p.listings) {
      const r = toListingRecord(l);
      if (r) records.push(r);
    }
    return {
      totalHits: p.totalHits,
      zeroHits: p.zeroHits,
      maxPageLinked: p.maxPageLinked,
      records,
      skipped: p.listings.length - records.length,
    };
  }

  detectBlock(status: number, html: string): string | null {
    return detectBlock(status, html);
  }

  /**
   * 1 回で全件を取る（ListingSource 互換。ローカルの偽サーバ相手の確認用）。
   * 本番の日次取得は Workers の時間上限に収まらないので使わず、listing-crawl.ts のカーソル方式を使う。
   */
  async fetchActive(_env: Env): Promise<ListingRecord[]> {
    const out = new Map<string, ListingRecord>();
    let last = 0;
    for (const t of this.targets()) {
      let totalPages = 1;
      for (let page = 1; page <= totalPages; page++) {
        const wait = last + this.minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        const url = this.pageUrl(t, page);
        const res = await fetch(url, { headers: { "user-agent": this.userAgent, accept: "text/html" } });
        const html = await res.text();
        const block = this.detectBlock(res.status, html);
        if (block) throw new BlockedError(block, url);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${url}`);
        const p = this.parsePage(html, t);
        if (page === 1) totalPages = p.zeroHits ? 0 : Math.max(1, Math.ceil((p.totalHits ?? 0) / this.pageSize));
        for (const r of p.records) out.set(r.externalId, r);
      }
    }
    return [...out.values()];
  }
}

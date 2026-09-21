// 掲載情報の型のうち、Workers にも Node（Mac 側クローラ・テスト）にも依存しないもの。
// D1 や Env を参照しないので scripts/ からも import できる（src/listing.ts が再 export する）。

export interface ListingRecord {
  externalId: string;
  kind: "sale" | "rent";
  wardCode?: string;
  districtName?: string;
  buildingName?: string;
  buildingYear?: number;
  builtMonth?: number;
  areaSqm?: number;
  floorPlan?: string;
  lineName?: string;
  stationName?: string;
  walkMinutes?: number;
  /** 駅までバス便（walkMinutes は入れない） */
  bus?: boolean;
  address?: string;
  url?: string;
  /** 売買は総額（円）、賃貸は月額賃料（円） */
  price: number;
}

export interface CrawlTarget {
  /** 市区町村コード（5 桁） */
  areaCode: string;
  /** 情報源側のキー（SUUMO なら sc_<slug> の slug） */
  key: string;
}

export interface ParsedListPage {
  /** 検索全体のヒット件数。0 件ページは zeroHits=true・totalHits=null */
  totalHits: number | null;
  zeroHits: boolean;
  maxPageLinked: number | null;
  records: ListingRecord[];
  /** 価格が読めず捨てた件数 */
  skipped: number;
}

/** 検索結果をページ単位で取る情報源のうち、取得と解析に要る部分（D1 に触らない） */
export interface PagedSource {
  readonly id: string;
  readonly pageSize: number;
  readonly userAgent: string;
  targets(): CrawlTarget[];
  pageUrl(target: CrawlTarget, page: number): string;
  parsePage(html: string, target: CrawlTarget): ParsedListPage;
  /** 止まるべき応答なら種別（"http_429" 等）、問題なければ null。3xx は redirect（要求 URL と Location）で判定 */
  detectBlock(status: number, html: string, redirect?: { url: string; location: string | null }): string | null;
}

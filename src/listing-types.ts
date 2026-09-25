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

  // ---- 賃貸（kind = "rent"）だけの項目。売買では入れない ----
  /** 管理費・共益費（円/月）。「-」「なし」は 0 */
  adminFee?: number;
  /** 敷金（円）。「◯ヶ月」表記は 賃料 × 月数で円に直したもの。「-」「なし」は 0 */
  deposit?: number;
  /** 礼金（円）。敷金と同じ扱い */
  keyMoney?: number;
  /** ペット相談可（一覧の文言から。判定できなければ false） */
  petsAllowed?: boolean;
  /** 情報公開日・掲載日 "YYYY-MM-DD"（一覧から読めたときだけ。first_seen とは別） */
  listedOn?: string;
}

export interface CrawlTarget {
  /** 市区町村コード（5 桁） */
  areaCode: string;
  /** 情報源側のキー（SUUMO なら sc_<slug> の slug） */
  key: string;
}

/**
 * 新築マンション（SUUMO /ms/shinchiku/）の掲載 1 件。物件（分譲プロジェクト）単位か、住戸単位（新築の仲介掲載）。
 * 価格・面積は幅（下限〜上限）。価格未定は priceMin/priceMax を入れない（null で残す）。金額は円。
 */
export interface NewListingRecord {
  externalId: string;
  /** project = 分譲の物件単位（価格が幅・販売期） / unit = 住戸単位の掲載（1 住戸・1 価格） */
  listingType: "project" | "unit";
  wardCode?: string;
  buildingName?: string;
  address?: string;
  lineName?: string;
  stationName?: string;
  walkMinutes?: number;
  bus?: boolean;
  /** 円。価格未定なら無し */
  priceMin?: number;
  priceMax?: number;
  /** 価格未定の期・住戸がある（全部未定なら priceMin も無い） */
  priceUndecided?: boolean;
  /** 予定価格（「／予定」）・概算（「3800万円台」）を含む */
  priceTentative?: boolean;
  areaMin?: number;
  areaMax?: number;
  /** 円/㎡。間取りタイプ（価格と面積の組）が取れたらその範囲、無ければ 価格下限/面積下限〜価格上限/面積上限 */
  unitPriceMin?: number;
  unitPriceMax?: number;
  /** "2LDK・3LDK" など（表記そのまま・半角化） */
  floorPlans?: string;
  /** first_come（先着順）| phase（第N期）| final（最終期）| upcoming（価格未定・販売予定）| unit（住戸の掲載）| other */
  saleStatus?: string;
  /** 販売状況の表記（「東街区 先着順販売」「第2期2次」など。複数の期は " / " でつなぐ） */
  saleLabel?: string;
  /** 引渡時期の表記（「2028年7月下旬予定」「即引渡可」「相談」） */
  deliveryText?: string;
  /** 引渡時期 "YYYY-MM"（読めたときだけ） */
  deliveryYm?: string;
  deliveryImmediate?: boolean;
  url?: string;
}

export interface ParsedListPage<R = ListingRecord> {
  /** 検索全体のヒット件数。0 件ページは zeroHits=true・totalHits=null */
  totalHits: number | null;
  zeroHits: boolean;
  maxPageLinked: number | null;
  records: R[];
  /** 価格が読めず捨てた件数 */
  skipped: number;
}

/** 検索結果をページ単位で取る情報源のうち、取得と解析に要る部分（D1 に触らない） */
export interface PagedSource<R = ListingRecord> {
  readonly id: string;
  readonly pageSize: number;
  readonly userAgent: string;
  /**
   * true なら「総ページ数はページャの最大ページ番号を正とする」（件数 ÷ pageSize では出さない）。
   * 賃貸は件数表示が掲載の数で、一覧は建物ごとにまとめて出すため件数からページ数を出せない（src/suumo-chintai.ts）。
   * 未指定（中古・新築）は従来どおり 件数 ÷ pageSize で、ページャの方が大きければそちらに合わせる。
   */
  readonly pageCountFromLinks?: boolean;
  targets(): CrawlTarget[];
  pageUrl(target: CrawlTarget, page: number): string;
  parsePage(html: string, target: CrawlTarget): ParsedListPage<R>;
  /** 止まるべき応答なら種別（"http_429" 等）、問題なければ null。3xx は redirect（要求 URL と Location）で判定 */
  detectBlock(status: number, html: string, redirect?: { url: string; location: string | null }): string | null;
}

import type { Sekisho } from "./access";

export interface Env {
  DB: D1Database;
  /** 不動産情報ライブラリ API キー（未設定可。未設定なら cron は何もしない） */
  REINFOLIB_API_KEY?: string;

  // ---- 掲載情報（SUUMO）。README「掲載情報（SUUMO）」 ----
  /**
   * "off"（既定）| "on"（Worker の cron が SUUMO を取る）| "external"（Mac が取って POST /api/ingest/listings に送る。cron は取らない）。
   * 解釈は src/listing-crawl-core.ts の listingsMode
   */
  LISTINGS_ENABLED?: string;
  /** Mac 側クローラの取り込み用の共有シークレット（Bearer）。secret。未設定なら取り込みは全員 401 */
  LISTINGS_INGEST_TOKEN?: string;
  /** 取得に使う User-Agent（未設定なら src/suumo-source.ts の DEFAULT_USER_AGENT） */
  LISTINGS_USER_AGENT?: string;
  /** ページ間隔（ms）。本番（suumo.jp）は 30000 未満にできない（CRAWL.floorIntervalMs） */
  LISTINGS_MIN_INTERVAL_MS?: string;
  /** ↓ ローカルの偽サーバ（http://127.0.0.1:port）を指すときだけ効くテスト用の上書き */
  SUUMO_ORIGIN?: string;
  LISTINGS_RUN_BUDGET_MS?: string;
  LISTINGS_MAX_PAGES_PER_INVOCATION?: string;
  LISTINGS_TODAY_OVERRIDE?: string;

  // ---- /listings・/api/listings の Cloudflare Access（src/access.ts・検証は関所 sekisho に聞く） ----
  /** 関所への Service Binding（wrangler.toml の [[services]]）。未設定なら全員拒否 */
  SEKISHO?: Sekisho;
  /** Access アプリの Application Audience (AUD) Tag */
  CF_ACCESS_AUD?: string;
  /** "1" かつ localhost のときだけ認証を迂回（.dev.vars 専用） */
  DEV_BYPASS_ACCESS?: string;
}

export function hasReinfolibKey(env: Env): boolean {
  return typeof env.REINFOLIB_API_KEY === "string" && env.REINFOLIB_API_KEY.trim() !== "";
}

export interface Env {
  DB: D1Database;
  /** 不動産情報ライブラリ API キー（未設定可。未設定なら cron は何もしない） */
  REINFOLIB_API_KEY?: string;
}

export function hasReinfolibKey(env: Env): boolean {
  return typeof env.REINFOLIB_API_KEY === "string" && env.REINFOLIB_API_KEY.trim() !== "";
}

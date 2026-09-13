-- 掲載情報（SUUMO・私的利用・既定 off）の日次クロール用（2026-09-14）。src/listing-crawl.ts
--
-- listings 系の器（0001）はそのまま使い、足りない列とクロールの状態テーブルを足す。
-- 価格は既存どおり円（listings.current_price / listing_price_history.price）。万円は表示側で割る。
-- ⚠️ 追加だけ（既存行・既存の Worker を壊さない）。LISTINGS_ENABLED=off の間は全部空のまま。

ALTER TABLE listings ADD COLUMN built_month     INTEGER;
ALTER TABLE listings ADD COLUMN line_name       TEXT;
ALTER TABLE listings ADD COLUMN bus             INTEGER NOT NULL DEFAULT 0;   -- 1 = 駅までバス便（walk_minutes は NULL）
ALTER TABLE listings ADD COLUMN address         TEXT;
ALTER TABLE listings ADD COLUMN first_price     INTEGER;                      -- 初出時の価格（円）
ALTER TABLE listings ADD COLUMN price_cut_count INTEGER NOT NULL DEFAULT 0;   -- 値下げを観測した回数
ALTER TABLE listings ADD COLUMN relisted_count  INTEGER NOT NULL DEFAULT 0;   -- 掲載終了後に再び見えた回数
ALTER TABLE listings ADD COLUMN missed_runs     INTEGER NOT NULL DEFAULT 0;   -- 完走回で続けて見えなかった回数
ALTER TABLE listings ADD COLUMN last_seen_run   TEXT;                         -- 最後に見えた listing_crawl_runs.run_id

CREATE INDEX IF NOT EXISTS idx_listings_run   ON listings (source, last_seen_run);
CREATE INDEX IF NOT EXISTS idx_listings_state ON listings (source, delisted_on, first_seen);

-- 1 日 1 回ぶんのクロール（複数の cron 起動にまたがる）
CREATE TABLE IF NOT EXISTS listing_crawl_runs (
  run_id              TEXT    PRIMARY KEY,       -- '<source>:<YYYY-MM-DD>'
  source              TEXT    NOT NULL,
  crawl_date          TEXT    NOT NULL,          -- JST
  status              TEXT    NOT NULL,          -- running | complete | incomplete | blocked
  started_at          TEXT    NOT NULL,
  finished_at         TEXT,
  updated_at          TEXT    NOT NULL,
  lease_until         TEXT,                      -- 二重起動よけ
  invocations         INTEGER NOT NULL DEFAULT 0,
  pages_fetched       INTEGER NOT NULL DEFAULT 0,
  listings_seen       INTEGER NOT NULL DEFAULT 0, -- 締めたときの COUNT(last_seen_run = run_id)
  total_hits          INTEGER NOT NULL DEFAULT 0, -- 各市区町村の件数表示の合計
  new_count           INTEGER NOT NULL DEFAULT 0,
  price_change_count  INTEGER NOT NULL DEFAULT 0,
  gone_count          INTEGER NOT NULL DEFAULT 0, -- complete のときだけ付く
  skipped_count       INTEGER NOT NULL DEFAULT 0, -- 価格が読めず捨てた件数
  note                TEXT,
  UNIQUE (source, crawl_date)
);

-- 回 × 市区町村ごとの続きの位置
CREATE TABLE IF NOT EXISTS listing_crawl_cursor (
  run_id       TEXT    NOT NULL,
  area_code    TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  next_page    INTEGER NOT NULL DEFAULT 1,
  total_pages  INTEGER,
  total_hits   INTEGER,
  seen         INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | done | error
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (run_id, area_code)
);

-- 情報源ごとの状態（ページ間隔を起動をまたいで守る・止められたらクールダウン）
CREATE TABLE IF NOT EXISTS listing_crawl_state (
  source           TEXT PRIMARY KEY,
  last_fetch_at    TEXT,
  cooldown_until   TEXT,
  last_block_kind  TEXT,   -- http_403 | http_429 | http_503 | captcha | unexpected_structure
  last_block_at    TEXT
);

-- 止まった・失敗した・締めたの記録
CREATE TABLE IF NOT EXISTS listing_crawl_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT    NOT NULL,
  run_id       TEXT,
  at           TEXT    NOT NULL,
  kind         TEXT    NOT NULL,   -- blocked | error | skipped_delist | finalized
  http_status  INTEGER,
  url          TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_events ON listing_crawl_events (source, id);

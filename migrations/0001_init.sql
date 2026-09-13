-- 不動産情報ライブラリ XIT001 の「中古マンション等」だけを保持する。
-- 冪等性: (ward_code, year, quarter) 単位で DELETE → INSERT を 1 バッチで行う（src/ingest.ts）。
CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_code       TEXT    NOT NULL,           -- 40131..40137
  year            INTEGER NOT NULL,
  quarter         INTEGER NOT NULL,           -- 1..4
  price_category  TEXT    NOT NULL,           -- 'transaction'（取引価格 2005Q3〜）| 'contract'（成約価格 2021Q1〜）
  district_name   TEXT,
  district_code   TEXT,                       -- ⚠️ API 側で変わりうる（継続性保証なし）。集計は district_name で行う
  trade_price     INTEGER NOT NULL,           -- 円
  area_sqm        REAL,                       -- ㎡（"2,000㎡以上" 等は下限値）
  area_capped     INTEGER NOT NULL DEFAULT 0, -- 1 = 「〜以上」表記だった
  unit_price      INTEGER,                    -- 円/㎡（中古マンションは API が空なので trade_price/area_sqm で算出）
  building_year   INTEGER,                    -- 西暦。戦前・不明は NULL
  floor_plan      TEXT,
  structure       TEXT,
  renovation      TEXT,
  city_planning   TEXT,
  remarks         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_period ON transactions (ward_code, year, quarter);
CREATE INDEX IF NOT EXISTS idx_tx_cat_period ON transactions (price_category, year, quarter);
CREATE INDEX IF NOT EXISTS idx_tx_district ON transactions (ward_code, district_name);

-- 取り込みの記録（cron が「今日まだ取っていない」ものだけ取るのに使う）
CREATE TABLE IF NOT EXISTS fetch_log (
  source      TEXT    NOT NULL,   -- 'reinfolib:XIT001' など
  ward_code   TEXT    NOT NULL,
  year        INTEGER NOT NULL,
  quarter     INTEGER NOT NULL,
  status      TEXT    NOT NULL,   -- 'ok' | 'empty' | 'error' | 'no_key'
  rows        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  fetched_at  TEXT    NOT NULL,   -- ISO8601 UTC
  PRIMARY KEY (source, ward_code, year, quarter)
);

-- 区（将来は地区・駅）単位の統計指標。賃貸需要の指標をここに入れる。
CREATE TABLE IF NOT EXISTS area_stats (
  area_level  TEXT    NOT NULL,   -- 'ward' | 'district' | 'station'
  area_code   TEXT    NOT NULL,   -- ward なら 40131 等
  indicator   TEXT    NOT NULL,   -- 'population', 'households', 'vacant_rental_rate' 等
  period      TEXT    NOT NULL,   -- '2020', '2023', '2026-08' 等
  value       REAL,
  unit        TEXT,
  source      TEXT    NOT NULL,   -- 'estat:<statsDataId>' 等
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (area_level, area_code, indicator, period)
);

-- 駅別乗降客数（不動産情報ライブラリ XKT015 = 国土数値情報 S12）。scripts/load-geo.ts が入れる。
CREATE TABLE IF NOT EXISTS station_passengers (
  station_code  TEXT    NOT NULL,
  operator      TEXT    NOT NULL,
  line          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  lon           REAL,
  lat           REAL,
  year          INTEGER NOT NULL,
  passengers    INTEGER,
  PRIMARY KEY (station_code, operator, line, year)
);

-- ===== Data source B（掲載情報）用の器。許諾された情報源が見つかるまで空のまま =====
CREATE TABLE IF NOT EXISTS listings (
  source          TEXT    NOT NULL,   -- アダプタ ID
  external_id     TEXT    NOT NULL,   -- 情報源側の物件 ID
  kind            TEXT    NOT NULL DEFAULT 'sale',  -- 'sale' | 'rent'
  ward_code       TEXT,
  district_name   TEXT,
  building_name   TEXT,
  building_year   INTEGER,
  area_sqm        REAL,
  floor_plan      TEXT,
  station_name    TEXT,
  walk_minutes    INTEGER,
  url             TEXT,
  first_seen      TEXT    NOT NULL,   -- YYYY-MM-DD（JST）
  last_seen       TEXT    NOT NULL,
  current_price   INTEGER,            -- 売買は総額（円）、賃貸は月額賃料（円）
  delisted_on     TEXT,               -- last_seen 翌日以降に見えなくなったら設定。掲載日数 = delisted_on - first_seen
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_ward ON listings (kind, ward_code, delisted_on);

CREATE TABLE IF NOT EXISTS listing_price_history (
  source       TEXT    NOT NULL,
  external_id  TEXT    NOT NULL,
  observed_on  TEXT    NOT NULL,      -- 価格が変わった（または初出の）日
  price        INTEGER NOT NULL,
  PRIMARY KEY (source, external_id, observed_on)
);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  source       TEXT    NOT NULL,
  snapshot_on  TEXT    NOT NULL,      -- YYYY-MM-DD（JST）
  seen_count   INTEGER NOT NULL,
  new_count    INTEGER NOT NULL,
  gone_count   INTEGER NOT NULL,
  PRIMARY KEY (source, snapshot_on)
);

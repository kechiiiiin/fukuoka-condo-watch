-- 新築マンション（SUUMO /ms/shinchiku/・私的利用）の週次クロール用（2026-09-22）。src/suumo-shinchiku.ts・src/listing-crawl.ts
--
-- 中古（listings）とは表を分ける。新築は物件（分譲プロジェクト）単位で、価格・面積が幅を持ち、価格未定がある。
-- クロールの状態（listing_crawl_runs / _cursor / _state / _events）と日次の件数（listing_snapshots）は
-- 取得元 ID（source = 'suumo:ms-shinchiku'）で分かれるので、0003 の表をそのまま共用する。
-- 金額は円（表示側で万円に割る）。⚠️ 追加だけ（既存の表・行に触らない）。

CREATE TABLE IF NOT EXISTS new_listings (
  source              TEXT    NOT NULL,              -- 'suumo:ms-shinchiku'
  external_id         TEXT    NOT NULL,              -- nc_<数字>
  listing_type        TEXT    NOT NULL,              -- 'project'（分譲の物件単位）| 'unit'（住戸単位の掲載）
  ward_code           TEXT,                          -- 市区町村コード（5 桁）
  building_name       TEXT,
  address             TEXT,
  line_name           TEXT,
  station_name        TEXT,
  walk_minutes        INTEGER,                       -- バス便なら NULL
  bus                 INTEGER NOT NULL DEFAULT 0,
  price_min           INTEGER,                       -- 円。NULL = 価格未定（全部の期・住戸が未定）
  price_max           INTEGER,
  price_undecided     INTEGER NOT NULL DEFAULT 0,    -- 1 = 価格未定の期・住戸を含む
  price_tentative     INTEGER NOT NULL DEFAULT 0,    -- 1 = 予定価格・「◯◯万円台」を含む
  area_min            REAL,                          -- ㎡
  area_max            REAL,
  unit_price_min      INTEGER,                       -- 円/㎡（間取りタイプの価格と面積の組から。無ければ価格幅/面積幅の目安）
  unit_price_max      INTEGER,
  floor_plans         TEXT,                          -- "2LDK・3LDK"
  sale_status         TEXT,                          -- first_come | phase | final | upcoming | selling | unit | other
  sale_label          TEXT,                          -- 表記そのまま（「東街区 先着順販売 / 第7期」）
  delivery_text       TEXT,                          -- 引渡時期の表記（「2028年7月下旬予定」「即引渡可」「相談」）
  delivery_ym         TEXT,                          -- 'YYYY-MM'（読めたときだけ）
  delivery_immediate  INTEGER NOT NULL DEFAULT 0,
  url                 TEXT,
  first_seen          TEXT    NOT NULL,              -- YYYY-MM-DD（JST。週次の回の日付）
  last_seen           TEXT    NOT NULL,
  first_price_min     INTEGER,                       -- 初めて価格が出たときの幅（最初は未定だった物件は決まった回の値）
  first_price_max     INTEGER,
  price_change_count  INTEGER NOT NULL DEFAULT 0,    -- 下限か上限が変わった回数（未定 → 決定も 1 回）
  relisted_count      INTEGER NOT NULL DEFAULT 0,
  missed_runs         INTEGER NOT NULL DEFAULT 0,    -- 完走回で続けて見えなかった回数（2 回で掲載終了）
  delisted_on         TEXT,                          -- 掲載終了（完売・掲載終了）を付けた回の日付
  last_seen_run       TEXT,
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_new_listings_run   ON new_listings (source, last_seen_run);
CREATE INDEX IF NOT EXISTS idx_new_listings_state ON new_listings (source, delisted_on, ward_code);

CREATE TABLE IF NOT EXISTS new_listing_price_history (
  source       TEXT    NOT NULL,
  external_id  TEXT    NOT NULL,
  observed_on  TEXT    NOT NULL,   -- 初出または価格の幅が変わった回の日付
  price_min    INTEGER,            -- 円。NULL = 未定
  price_max    INTEGER,
  PRIMARY KEY (source, external_id, observed_on)
);

-- 掲載（中古・賃貸）の建物の座標を listings に足す（2026-10-31）。src/listing-crawl-core.ts（UPDATE_COORDS_SQL）・
-- scripts/suumo-coords.ts（Mac 側で詳細ページから読む）・src/bus-access.ts（直通バス停まで徒歩5分以内の判定）。
--
-- 何に使うか: /listings/picks の「見ているエリア」の「バスで職場・学校へ直通」ボタン（area=bus）と、
-- カードの「職場へ直通: ◯◯ 徒歩N分」。住所は丁目までしか無いので、詳細ページの地図の座標を使う。
--
-- 座標の在りか（2026-10-31 に本番で 1 件ずつ確認）:
--   中古 … 詳細ページ（/ms/chuko/fukuoka/sc_*/nc_<id>/）の地図の初期化 `initIdo : '33.57…'`・`initKeido : '130.40…'`
--   賃貸 … 詳細ページ（/chintai/jnc_*/?bc=*）には**無い**。周辺環境ページ（/chintai/jnc_*/kankyo/?bc=*）の
--          <script id="js-gmapData"> の JSON（"center": {"lat": …, "lng": …}）にある
--
-- ⚠️ 追加だけ（既存の列・行・Worker を壊さない）。
-- ⚠️ NULL の意味:
--   lat / lng        … 建物の緯度・経度（世界測地系の 10 進度）。**NULL = 未取得または読めなかった**
--   coord_fetched_at … 座標を取りに行った時刻（ISO8601）。**座標が読めなくても入れる**（毎回取り直さないため）
-- ⚠️ 一覧の毎日の UPSERT（UPSERT_LISTINGS_SQL）はこの 3 列を**触らない**（ldk_tatami・detail_fetched_at と同じ扱い）。
ALTER TABLE listings ADD COLUMN lat              REAL;  -- 緯度
ALTER TABLE listings ADD COLUMN lng              REAL;  -- 経度
ALTER TABLE listings ADD COLUMN coord_fetched_at TEXT;  -- 座標を取りに行った時刻（読めなくても入れる）

-- 座標を取る相手（= 掲載中で未取得のもの）を引くための索引
CREATE INDEX IF NOT EXISTS idx_listings_coord_todo ON listings (source, delisted_on, coord_fetched_at);

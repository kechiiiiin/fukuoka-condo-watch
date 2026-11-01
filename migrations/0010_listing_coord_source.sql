-- 掲載の座標の出どころと、国土地理院の住所検索を試した時刻を足す（2026-11-01）。
-- src/listing-crawl-core.ts（SHARE_*_COORDS_SQL・COORD_TARGETS_SQL・GSI_*）・scripts/gsi-coords.ts。
--
-- なぜ: SUUMO は 1 日約 180 件で止める（redirect_challenge）。未取得の掲載は 7,667 件あるが、建物（建物名 + 住所）
-- 単位では約 3,700 棟しかない。そこで
--   1. 同じ建物の他の掲載から座標を使い回す（SUUMO で取るのは 1 棟 1 件だけ）
--   2. 住所に番地まである掲載（中古の約 1,000 件）は、国土地理院の住所検索で仮の座標を先に入れる
--      （SUUMO の座標が取れたら上書きする）
--
-- ⚠️ 追加だけ（既存の列・行・Worker を壊さない）。
-- ⚠️ 値の意味:
--   coord_source … lat / lng の出どころ。'suumo'（SUUMO のページの地図）| 'gsi'（国土地理院の住所検索の仮座標）。
--                  lat が NULL なら NULL。同じ建物の他の掲載から写した座標も、元の出どころを入れる
--   gsi_tried_at … 国土地理院の住所検索を試した時刻（ISO8601）。**番地まで一致せず採らなかったときも入れる**（取り直さないため）
ALTER TABLE listings ADD COLUMN coord_source TEXT;  -- 'suumo' | 'gsi'
ALTER TABLE listings ADD COLUMN gsi_tried_at TEXT;  -- 国土地理院の住所検索を試した時刻

-- 0009 から今までに入った座標は全部 SUUMO のページから
UPDATE listings SET coord_source = 'suumo' WHERE lat IS NOT NULL AND coord_source IS NULL;

-- 同じ建物（trim した建物名 + 住所）を引くための索引。SHARE_*_COORDS_SQL の式と同じ形にしてある
CREATE INDEX IF NOT EXISTS idx_listings_building_key ON listings (trim(building_name), trim(address));

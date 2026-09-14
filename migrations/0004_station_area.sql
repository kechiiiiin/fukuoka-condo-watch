-- 駅を市区町村にひも付ける（2026-09-14）。貸しやすさの「駅乗降客数の増減」に使う。
-- scripts/load-geo.ts が XKT013（250m メッシュ・SHICODE 付き）の中で駅の位置を含むメッシュを探して入れる。
-- ⚠️ 追加だけ（既存行・既存の Worker を壊さない）。未設定の行は NULL のまま（指標から除かれる）。
ALTER TABLE station_passengers ADD COLUMN area_code TEXT;
CREATE INDEX IF NOT EXISTS idx_station_area ON station_passengers (area_code, year);

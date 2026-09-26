-- 賃貸の「理想条件」に要る項目を listings に足す（2026-09-26）。src/suumo-chintai.ts・src/listing-crawl.ts
--
-- Keisuke の条件（2026-09-26 に確定）:
--   ① 住戸がワンフロアであること（**メゾネット＝室内2層は不可**）
--   ② LDK が 15 畳以上（各部屋は狭くてよい）
--   ※ 「建物が2階建て」は**嫌ではない**（当初そう聞いたが本人に確認して取り消し）。
--      building_floors / room_floor は**情報として画面に出すためだけ**に保存し、既定の絞り込みには使わない。
--
-- ⚠️ 追加だけ（既存の列・行・Worker を壊さない）。sale の行はすべて NULL のまま。
--
-- ⚠️ NULL の意味:
--   building_floors … 建物の階数。一覧の cassetteitem_detail-col3（「8階建」）から。読めなければ NULL
--   room_floor      … 部屋の階。一覧の <td>（「4階」）から。「1-2階」のような範囲表記は**一番下の階**を入れる。
--                     「-」「地下」だけ等で読めなければ NULL
--   maisonette      … 1 = メゾネット（室内が 2 層）/ **NULL = 不明（メゾネットでないという意味ではない）**。0 は入れない。
--                     立つのは 2 通り:
--                       (a) 一覧の部屋の階が範囲表記（「1-2階」）= その住戸が 2 フロアにまたがっている（1 周目 suumo:chintai）
--                       (b) メゾネット絞り込み（/nj_113/）付きの 3 周目（source = 'suumo:chintai-maisonette'）で見えた
--                     ペット可（pets_allowed）と同じく、1 周目の UPSERT は (a) の判定結果で毎回上書きするので、
--                     (b) の周回は**必ず 1 周目の後**に走らせる（ops/launchd/）
--   ldk_tatami      … LDK の畳数（詳細ページ /chintai/jnc_*/?bc=* の「間取り詳細」から。例 16.5）。
--                     **NULL = 未取得**（15 畳未満という意味ではない）。画面では「未取得」と出す
--   detail_fetched_at … 詳細ページを取った時刻（ISO8601）。**畳数が読めなくても入れる**（同じ部屋を取り直さないため）
ALTER TABLE listings ADD COLUMN building_floors   INTEGER;  -- 建物の階数（「8階建」→ 8）
ALTER TABLE listings ADD COLUMN room_floor        INTEGER;  -- 部屋の階（「4階」→ 4・「1-2階」→ 1）
ALTER TABLE listings ADD COLUMN maisonette        INTEGER;  -- 1 = メゾネット（室内2層）/ NULL = 不明
ALTER TABLE listings ADD COLUMN ldk_tatami        REAL;     -- LDK の畳数（詳細ページから）。NULL = 未取得
ALTER TABLE listings ADD COLUMN detail_fetched_at TEXT;     -- 詳細ページを取った時刻（読めなくても入れる）

-- 詳細ページを取る相手（= 全条件を通った掲載中の賃貸のうち未取得のもの）を引くための索引
CREATE INDEX IF NOT EXISTS idx_listings_detail_todo ON listings (source, kind, delisted_on, detail_fetched_at);

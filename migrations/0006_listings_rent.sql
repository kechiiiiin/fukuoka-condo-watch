-- 賃貸（SUUMO /chintai/・私的利用・2026-09-26）の項目を listings に足す。src/suumo-chintai.ts・src/listing-crawl.ts
--
-- 賃貸は中古（listings.kind = 'sale'）と同じ表に kind = 'rent' で入れる（0001 の時点で枠がある）。
-- 金額はすべて円。current_price = 月額賃料（0001 のコメントどおり）。
-- 中古に無かった項目（管理費・敷金・礼金・ペット相談可・掲載日）だけを足す。
-- ⚠️ 追加だけ（既存の列・行・Worker を壊さない）。sale の行はすべて NULL / 既定値のまま。

ALTER TABLE listings ADD COLUMN admin_fee    INTEGER;                    -- 管理費・共益費（円/月）。「-」「なし」は 0
ALTER TABLE listings ADD COLUMN deposit      INTEGER;                    -- 敷金（円）。「◯ヶ月」は 賃料 × 月数
ALTER TABLE listings ADD COLUMN key_money    INTEGER;                    -- 礼金（円）。同上
ALTER TABLE listings ADD COLUMN pets_allowed INTEGER NOT NULL DEFAULT 0; -- 1 = ペット相談可（一覧の文言から）
ALTER TABLE listings ADD COLUMN listed_on    TEXT;                       -- 情報公開日 'YYYY-MM-DD'（読めたときだけ。first_seen とは別）

-- /listings/picks?kind=rent が「掲載中の賃貸」を引くための索引（kind + 掲載中）
CREATE INDEX IF NOT EXISTS idx_listings_source_kind ON listings (source, kind, delisted_on);

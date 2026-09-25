-- 賃貸（SUUMO /chintai/・私的利用・2026-09-26）の項目を listings に足す。src/suumo-chintai.ts・src/listing-crawl.ts
--
-- 賃貸は中古（listings.kind = 'sale'）と同じ表に kind = 'rent' で入れる（0001 の時点で枠がある）。
-- 金額はすべて円。current_price = 月額賃料（0001 のコメントどおり）。
-- 中古に無かった項目（管理費・敷金・礼金・ペット相談可・掲載日）だけを足す。
-- ⚠️ 追加だけ（既存の列・行・Worker を壊さない）。sale の行はすべて NULL / 既定値のまま。

-- ⚠️ NULL の意味（2026-09-26 に実ページで確認した SUUMO 賃貸一覧の表記に合わせている）:
--   admin_fee / deposit / key_money … 一覧の表記が "-" のとき NULL（「0 円」か「表記なし」か一覧からは決められないため）。
--                                     「なし」と書いてあるときだけ 0 を入れる
--   pets_allowed … NULL = 不明（**ペット不可という意味ではない**）。1 = ペット相談可。
--                  ペット可否はカードに出ないので、ペット絞り込み（tc=0401102）付きの 2 周目（source = 'suumo:chintai-pets'）で
--                  見えた部屋にだけ 1 を立てる。0 は入れない
--   listed_on … **賃貸では常に NULL**（掲載日・情報公開日が一覧に無い）。列は売買・将来の情報源のために残す
ALTER TABLE listings ADD COLUMN admin_fee    INTEGER;   -- 管理費・共益費（円/月）
ALTER TABLE listings ADD COLUMN deposit      INTEGER;   -- 敷金（円）。「◯ヶ月」表記は 賃料 × 月数
ALTER TABLE listings ADD COLUMN key_money    INTEGER;   -- 礼金（円）。同上
ALTER TABLE listings ADD COLUMN pets_allowed INTEGER;   -- 1 = ペット相談可 / NULL = 不明
ALTER TABLE listings ADD COLUMN listed_on    TEXT;      -- 情報公開日 'YYYY-MM-DD'（賃貸では常に NULL）

-- /listings/picks?kind=rent が「掲載中の賃貸」を引くための索引（kind + 掲載中）
CREATE INDEX IF NOT EXISTS idx_listings_source_kind ON listings (source, kind, delisted_on);

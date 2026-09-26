-- listings.maisonette を二値（0 = メゾネットでない / 1 = メゾネット）にする（2026-09-27）。
-- src/listing-crawl-core.ts（UPSERT_LISTINGS_SQL・UPDATE_DETAIL_SQL）・src/listings-picks-dashboard.ts
--
-- ⚠️ **0007 の「maisonette は 0 は入れない・NULL = 不明」という設計はここで取り消した**（0007 自体は履歴なので直さない）。
--    やめた理由: 1 を立てられるのはメゾネット絞り込みの 3 周目（/nj_113/）で見えた部屋だけなので、
--    それ以外は全部 NULL = 「メゾネット 不明」になり、/listings/picks のほぼ全カードが「不明」バッジで埋まっていた。
--    3 周目は全市区町村を完走しているので、表示上の推定ではなく**データの持ち方**を 0/1 に変える（Keisuke 判断・2026-09-27）。
--
-- これ以降の決めごと:
--   - 0 を書くのは **1 周目の一覧クロールの upsert だけ**（毎週いったんフラグを落とす）
--   - 1 を立てるのは 3 周目（UPDATE_MAISONETTE）と、詳細ページで「メゾネット」タグが見えたとき（UPDATE_DETAIL_SQL）
--   - **割り切り: 3 周目が落ちた週は、本当はメゾネットの部屋も 0 のまま残る**（1 周目が毎週 0 に戻すため。Keisuke 了解済み）。
--     どの回まで 3 周目が完走したかは listing_crawl_runs（source = 'suumo:chintai-maisonette' AND status = 'complete'）で追える
--   - 一覧の階の範囲表記（「1-2階」）は判定に使わない（990c2a8 で 3 周目の 1 本に絞った。room_floor には残る）
--
-- ⚠️ 列の DEFAULT は SQLite では後から変えられない（テーブルを作り直すしかない）ので、
--    **書き手が必ず明示的に 0 / 1 を入れる**ことで既定 0 を保つ（listingUpsertRow の mais は 0 か 1 しか返さない）。
--    読み手（src/listing-grouping.ts・src/listing-picks.ts）は、移行前の行が残っていても困らないよう NULL を 0 と同じに扱う。

UPDATE listings SET maisonette = 0 WHERE maisonette IS NULL;

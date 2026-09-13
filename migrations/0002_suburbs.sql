-- 福岡都市圏の近郊 16 市町への対応拡大（2026-09-14）
--
-- 方針: 既存の ward_code 列（transactions / fetch_log / listings）は列名を変えず、
--       「市区町村コード（5 桁）」として区と市町の両方を入れる。
--       列名変更はテーブル・インデックスの作り直しと、マイグレーション適用〜デプロイの間に
--       旧 Worker が壊れる時間帯を生むので避けた（値の意味が広がるだけで既存データはそのまま使える）。

-- 対象市区町村の台帳（アドホックな SQL 集計用。アプリの正は src/wards.ts）
CREATE TABLE IF NOT EXISTS municipalities (
  code        TEXT    PRIMARY KEY,           -- 全国地方公共団体コード上位 5 桁
  name        TEXT    NOT NULL,
  area_group  TEXT    NOT NULL,              -- 'city'（福岡市の区）| 'suburb'（近郊）
  subgroup    TEXT    NOT NULL,              -- 福岡市 / 筑紫地区 / 糸島 / 宗像・古賀・福津 / 粕屋郡
  sort_order  INTEGER NOT NULL
);

INSERT OR REPLACE INTO municipalities (code, name, area_group, subgroup, sort_order) VALUES
  ('40131', '東区',     'city',   '福岡市',           1),
  ('40132', '博多区',   'city',   '福岡市',           2),
  ('40133', '中央区',   'city',   '福岡市',           3),
  ('40134', '南区',     'city',   '福岡市',           4),
  ('40135', '西区',     'city',   '福岡市',           5),
  ('40136', '城南区',   'city',   '福岡市',           6),
  ('40137', '早良区',   'city',   '福岡市',           7),
  ('40217', '筑紫野市', 'suburb', '筑紫地区',         8),
  ('40218', '春日市',   'suburb', '筑紫地区',         9),
  ('40219', '大野城市', 'suburb', '筑紫地区',        10),
  ('40221', '太宰府市', 'suburb', '筑紫地区',        11),
  ('40231', '那珂川市', 'suburb', '筑紫地区',        12),
  ('40230', '糸島市',   'suburb', '糸島',            13),
  ('40220', '宗像市',   'suburb', '宗像・古賀・福津', 14),
  ('40223', '古賀市',   'suburb', '宗像・古賀・福津', 15),
  ('40224', '福津市',   'suburb', '宗像・古賀・福津', 16),
  ('40341', '宇美町',   'suburb', '粕屋郡',          17),
  ('40342', '篠栗町',   'suburb', '粕屋郡',          18),
  ('40343', '志免町',   'suburb', '粕屋郡',          19),
  ('40344', '須恵町',   'suburb', '粕屋郡',          20),
  ('40345', '新宮町',   'suburb', '粕屋郡',          21),
  ('40348', '久山町',   'suburb', '粕屋郡',          22),
  ('40349', '粕屋町',   'suburb', '粕屋郡',          23);

-- area_stats の区単位の行を「市区町村単位」に一般化する（'ward' → 'municipality'）。
-- PRIMARY KEY に area_level が入っているので、同じキーの 'municipality' 行が既にあれば古い 'ward' 行は捨てる。
DELETE FROM area_stats
 WHERE area_level = 'ward'
   AND EXISTS (SELECT 1 FROM area_stats m
                WHERE m.area_level = 'municipality' AND m.area_code = area_stats.area_code
                  AND m.indicator = area_stats.indicator AND m.period = area_stats.period);
UPDATE area_stats SET area_level = 'municipality' WHERE area_level = 'ward';

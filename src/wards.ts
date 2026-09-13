// 対象の市区町村（福岡市 7 区 + 福岡都市圏の近郊 16 市町）。
// コードは全国地方公共団体コードの上位 5 桁（XIT001 の city パラメータ・e-Stat の cdArea と同じ）。
// 2026-09-14 に次の 2 つの公式資料で 23 件すべて突き合わせて確認（推測で足さないこと）:
//   - 総務省「全国地方公共団体コード」令和6年1月1日現在 https://www.soumu.go.jp/main_content/000925835.xlsx
//     （掲載ページ https://www.soumu.go.jp/denshijiti/code.html 。6 桁目は検査数字）
//   - 福岡県「市区町村コード表（福岡県）」 https://www.pref.fukuoka.lg.jp/uploaded/attachment/59124.pdf
// ⚠️ DB の列名は歴史的経緯で ward_code のまま（区だけでなく市町のコードも入る）。migrations/0002 参照。

export type AreaGroup = "city" | "suburb";

export const GROUP_LABEL: Record<AreaGroup, string> = {
  city: "福岡市（区）",
  suburb: "近郊",
};

export interface Area {
  code: string;
  name: string;
  /** city = 福岡市の区 / suburb = 近郊の市町 */
  group: AreaGroup;
  /** 地域のまとまり（表示用） */
  subgroup: string;
}

export const AREAS: readonly Area[] = [
  { code: "40131", name: "東区", group: "city", subgroup: "福岡市" },
  { code: "40132", name: "博多区", group: "city", subgroup: "福岡市" },
  { code: "40133", name: "中央区", group: "city", subgroup: "福岡市" },
  { code: "40134", name: "南区", group: "city", subgroup: "福岡市" },
  { code: "40135", name: "西区", group: "city", subgroup: "福岡市" },
  { code: "40136", name: "城南区", group: "city", subgroup: "福岡市" },
  { code: "40137", name: "早良区", group: "city", subgroup: "福岡市" },
  { code: "40217", name: "筑紫野市", group: "suburb", subgroup: "筑紫地区" },
  { code: "40218", name: "春日市", group: "suburb", subgroup: "筑紫地区" },
  { code: "40219", name: "大野城市", group: "suburb", subgroup: "筑紫地区" },
  { code: "40221", name: "太宰府市", group: "suburb", subgroup: "筑紫地区" },
  { code: "40231", name: "那珂川市", group: "suburb", subgroup: "筑紫地区" },
  { code: "40230", name: "糸島市", group: "suburb", subgroup: "糸島" },
  { code: "40220", name: "宗像市", group: "suburb", subgroup: "宗像・古賀・福津" },
  { code: "40223", name: "古賀市", group: "suburb", subgroup: "宗像・古賀・福津" },
  { code: "40224", name: "福津市", group: "suburb", subgroup: "宗像・古賀・福津" },
  { code: "40341", name: "宇美町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40342", name: "篠栗町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40343", name: "志免町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40344", name: "須恵町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40345", name: "新宮町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40348", name: "久山町", group: "suburb", subgroup: "粕屋郡" },
  { code: "40349", name: "粕屋町", group: "suburb", subgroup: "粕屋郡" },
];

/** 福岡市の 7 区だけ */
export const WARDS: readonly Area[] = AREAS.filter((a) => a.group === "city");

export const AREA_NAME: Record<string, string> = Object.fromEntries(AREAS.map((a) => [a.code, a.name]));

export function isAreaCode(v: string): boolean {
  return Object.hasOwn(AREA_NAME, v);
}

/** ダッシュボードの表示範囲。all = すべて / city = 福岡市のみ / suburb = 近郊のみ */
export type Scope = "all" | AreaGroup;

/** 既定は「福岡市のみ」（拡張前の URL・ブックマークと同じ見え方を保つ） */
export function parseScope(v: string | null | undefined): Scope {
  return v === "all" || v === "suburb" ? v : "city";
}

export function areasInScope(scope: Scope): Area[] {
  return AREAS.filter((a) => scope === "all" || a.group === scope);
}

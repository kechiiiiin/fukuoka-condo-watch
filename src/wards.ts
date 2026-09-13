// 福岡市 7 区の市区町村コード（全国地方公共団体コードの上位 5 桁。XIT001 の city パラメータ）
export const WARDS = [
  { code: "40131", name: "東区" },
  { code: "40132", name: "博多区" },
  { code: "40133", name: "中央区" },
  { code: "40134", name: "南区" },
  { code: "40135", name: "西区" },
  { code: "40136", name: "城南区" },
  { code: "40137", name: "早良区" },
] as const;

export type WardCode = (typeof WARDS)[number]["code"];

export const WARD_NAME: Record<string, string> = Object.fromEntries(
  WARDS.map((w) => [w.code, w.name]),
);

export function isWardCode(v: string): v is WardCode {
  return v in WARD_NAME;
}

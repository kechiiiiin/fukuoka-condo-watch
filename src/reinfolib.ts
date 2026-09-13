// 国土交通省 不動産情報ライブラリ API クライアント
// 仕様: https://www.reinfolib.mlit.go.jp/help/apiManual/xit001/ （2026-09-14 確認）
//   GET https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001?year=YYYY&quarter=N&city=NNNNN[&priceClassification=01|02][&language=ja]
//   ヘッダ Ocp-Apim-Subscription-Key。出力は gzip の JSON（{ status, data: [...] }）。データなしは HTTP 404。
//   取引価格は 2005Q3〜、成約価格は 2021Q1〜。priceClassification 未指定で両方。

const BASE = "https://www.reinfolib.mlit.go.jp/ex-api/external";

/** XIT001 の出力（全フィールド文字列型） */
export interface Xit001Record {
  PriceCategory?: string;
  Type?: string;
  Region?: string;
  MunicipalityCode?: string;
  Prefecture?: string;
  Municipality?: string;
  DistrictName?: string;
  TradePrice?: string;
  PricePerUnit?: string;
  FloorPlan?: string;
  Area?: string;
  UnitPrice?: string;
  LandShape?: string;
  Frontage?: string;
  TotalFloorArea?: string;
  BuildingYear?: string;
  Structure?: string;
  Use?: string;
  Purpose?: string;
  Direction?: string;
  Classification?: string;
  Breadth?: string;
  CityPlanning?: string;
  CoverageRatio?: string;
  FloorAreaRatio?: string;
  Period?: string;
  Renovation?: string;
  Remarks?: string;
  DistrictCode?: string;
}

export class ReinfolibError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** gzip を自前で剥がす必要がある場合にも対応して JSON を読む */
async function readJson(res: Response): Promise<unknown> {
  const buf = new Uint8Array(await res.arrayBuffer());
  let bytes = buf;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function reinfolibGet(apiKey: string, apiId: string, params: Record<string, string>): Promise<unknown | null> {
  const url = new URL(`${BASE}/${apiId}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "Ocp-Apim-Subscription-Key": apiKey, "Accept-Encoding": "gzip" },
  });
  if (res.status === 404) return null; // データなし
  if (!res.ok) {
    throw new ReinfolibError(`${apiId} HTTP ${res.status}`, res.status);
  }
  return readJson(res);
}

export async function fetchXit001(
  apiKey: string,
  q: { year: number; quarter: number; city: string },
): Promise<Xit001Record[]> {
  const body = await reinfolibGet(apiKey, "XIT001", {
    year: String(q.year),
    quarter: String(q.quarter),
    city: q.city,
    language: "ja",
  });
  if (body === null) return [];
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Xit001Record[]) : [];
}

// ---------- パース ----------

export const CONDO_TYPE = "中古マンション等";

export interface ParsedTx {
  priceCategory: "transaction" | "contract";
  districtName: string | null;
  districtCode: string | null;
  tradePrice: number;
  areaSqm: number | null;
  areaCapped: boolean;
  unitPrice: number | null;
  buildingYear: number | null;
  floorPlan: string | null;
  structure: string | null;
  renovation: string | null;
  cityPlanning: string | null;
  remarks: string | null;
}

const toHalfWidth = (s: string) =>
  s.replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function parseNumber(s: string | undefined): { value: number | null; capped: boolean } {
  if (!s) return { value: null, capped: false };
  const t = toHalfWidth(s).replace(/,/g, "");
  const m = t.match(/\d+(\.\d+)?/);
  if (!m) return { value: null, capped: false };
  return { value: Number(m[0]), capped: /以上/.test(t) };
}

const ERA: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };

export function parseBuildingYear(s: string | undefined): number | null {
  if (!s) return null;
  const t = toHalfWidth(s);
  const west = t.match(/(\d{4})年/);
  if (west) return Number(west[1]);
  const era = t.match(/(明治|大正|昭和|平成|令和)(元|\d{1,2})年/);
  if (era) {
    const base = ERA[era[1] as string] ?? 0;
    return base + (era[2] === "元" ? 1 : Number(era[2]));
  }
  return null; // 「戦前」等
}

const blank = (s: string | undefined) => (s && s.trim() !== "" ? s.trim() : null);

export function parseCondo(r: Xit001Record): ParsedTx | null {
  if (r.Type !== CONDO_TYPE) return null;
  const price = parseNumber(r.TradePrice).value;
  if (price === null || price <= 0) return null;
  const area = parseNumber(r.Area);
  const apiUnit = parseNumber(r.UnitPrice).value;
  const unitPrice =
    apiUnit !== null && apiUnit > 0
      ? Math.round(apiUnit)
      : area.value && area.value > 0
        ? Math.round(price / area.value)
        : null;
  return {
    priceCategory: r.PriceCategory?.includes("成約") ? "contract" : "transaction",
    districtName: blank(r.DistrictName),
    districtCode: blank(r.DistrictCode),
    tradePrice: Math.round(price),
    areaSqm: area.value,
    areaCapped: area.capped,
    unitPrice,
    buildingYear: parseBuildingYear(r.BuildingYear),
    floorPlan: blank(r.FloorPlan),
    structure: blank(r.Structure),
    renovation: blank(r.Renovation),
    cityPlanning: blank(r.CityPlanning),
    remarks: blank(r.Remarks),
  };
}

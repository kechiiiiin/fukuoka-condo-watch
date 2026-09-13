// e-Stat API 3.0 から市区町村別（福岡市 7 区 + 近郊 16 市町）の統計を取り込む（ローカル実行・ESTAT_APP_ID を使う）
// 仕様: https://www.e-stat.go.jp/api/api-info/e-stat-manual3-0
//
//   npm run estat -- search 住宅・土地統計調査 空き家 [--statsCode 00200522]   # 表を探す（getStatsList）
//   npm run estat -- meta 0004021631                                           # 分類コードと対象市区町村のコードを見る（getMetaInfo）
//   npm run estat -- load [--remote]                                           # scripts/estat-indicators.json の定義で取り込む
//
// statsDataId と分類コードは推測で埋めず、search / meta で確かめてから estat-indicators.json に書く。
// 表によっては区だけ・市だけ・一定人口以上の町村だけを載せる。meta の「対象に無いコード」表示で抜けを確かめること。
import { readFileSync } from "node:fs";
import { AREAS as WARDS, isAreaCode } from "../src/wards";
import { executeSql, option, requireVar, sqlLit } from "./lib";

const BASE = "https://api.e-stat.go.jp/rest/3.0/app/json";
const appId = requireVar("ESTAT_APP_ID");

type Params = Record<string, string>;

async function call(endpoint: string, params: Params): Promise<any> {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("appId", appId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  return res.json();
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: any): string => (typeof v === "string" ? v : v?.$ ?? "");

async function search(words: string[]) {
  const body = await call("getStatsList", {
    searchWord: words.join(" AND "),
    limit: "50",
    ...(option("statsCode") ? { statsCode: option("statsCode") as string } : {}),
  });
  const list = body?.GET_STATS_LIST;
  if (list?.RESULT?.STATUS !== 0 && list?.RESULT?.STATUS !== undefined) console.warn(list.RESULT);
  for (const t of arr<any>(list?.DATALIST_INF?.TABLE_INF)) {
    console.log(`${t["@id"]}\t${text(t.SURVEY_DATE)}\t${text(t.STAT_NAME)}\t${text(t.TITLE)}`);
  }
}

async function meta(id: string) {
  const body = await call("getMetaInfo", { statsDataId: id });
  const info = body?.GET_META_INFO;
  console.log(text(info?.METADATA_INF?.TABLE_INF?.TITLE));
  for (const obj of arr<any>(info?.METADATA_INF?.CLASS_INF?.CLASS_OBJ)) {
    const classes = arr<any>(obj.CLASS);
    const isArea = obj["@id"] === "area";
    const shown = isArea ? classes.filter((c) => isAreaCode(String(c["@code"]))) : classes;
    console.log(`\n[${obj["@id"]}] ${obj["@name"]}（${classes.length} 区分${isArea ? "・対象市区町村分のみ表示" : ""}）`);
    for (const c of shown.slice(0, 200)) console.log(`  ${c["@code"]}\t${c["@name"]}${c["@unit"] ? `\t(${c["@unit"]})` : ""}`);
    if (isArea) {
      const have = new Set(shown.map((c) => String(c["@code"])));
      const lack = WARDS.filter((w) => !have.has(w.code));
      if (lack.length) console.log(`  ⚠️ この表に無い対象市区町村: ${lack.map((w) => `${w.name}(${w.code})`).join(",")}`);
    }
  }
}

interface Query {
  statsDataId: string;
  /** cdCat01 / cdTime / cdTab など getStatsData にそのまま渡す（cdArea は自動） */
  params: Params;
}
interface IndicatorDef {
  indicator: string;
  label: string;
  period: string;
  unit: string;
  /** value: numerator の合計 / ratio: numerator ÷ denominator × 100 / change: (numerator ÷ denominator − 1) × 100 */
  transform: "value" | "ratio" | "change";
  numerator: Query;
  denominator?: Query;
  verified: boolean;
  note?: string;
}

async function sumByWard(q: Query): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let start: string | undefined;
  do {
    const body = await call("getStatsData", {
      statsDataId: q.statsDataId,
      cdArea: WARDS.map((w) => w.code).join(","),
      ...q.params,
      ...(start ? { startPosition: start } : {}),
    });
    const sd = body?.GET_STATS_DATA?.STATISTICAL_DATA;
    for (const v of arr<any>(sd?.DATA_INF?.VALUE)) {
      const n = Number(v.$);
      if (!Number.isFinite(n)) continue; // "-" "…" などの秘匿・該当なし
      out.set(v["@area"], (out.get(v["@area"]) ?? 0) + n);
    }
    start = sd?.RESULT_INF?.NEXT_KEY ? String(sd.RESULT_INF.NEXT_KEY) : undefined;
  } while (start);
  return out;
}

async function load() {
  const defs = JSON.parse(readFileSync(new URL("./estat-indicators.json", import.meta.url), "utf8")) as IndicatorDef[];
  const now = new Date().toISOString();
  const stmts: string[] = [];
  for (const d of defs) {
    if (!d.verified || !d.numerator.statsDataId) {
      console.log(`skip ${d.indicator}（未確認: ${d.note ?? ""}）`);
      continue;
    }
    const num = await sumByWard(d.numerator);
    const den = d.denominator ? await sumByWard(d.denominator) : null;
    for (const w of WARDS) {
      const a = num.get(w.code);
      const b = den?.get(w.code);
      let value: number | null = null;
      if (a !== undefined) {
        if (d.transform === "value") value = a;
        else if (b) value = d.transform === "ratio" ? (100 * a) / b : (100 * (a - b)) / b;
      }
      console.log(`${d.indicator} ${w.name}: ${value === null ? "—" : value.toFixed(2)}`);
      stmts.push(
        `INSERT OR REPLACE INTO area_stats (area_level, area_code, indicator, period, value, unit, source, updated_at) VALUES ('municipality', ${sqlLit(w.code)}, ${sqlLit(d.indicator)}, ${sqlLit(d.period)}, ${sqlLit(value)}, ${sqlLit(d.unit)}, ${sqlLit(`estat:${d.numerator.statsDataId}`)}, ${sqlLit(now)})`,
      );
    }
  }
  executeSql(stmts, "estat");
}

const [cmd, ...rest] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
if (cmd === "search") await search(rest);
else if (cmd === "meta" && rest[0]) await meta(rest[0]);
else if (cmd === "load") await load();
else console.log("使い方: npm run estat -- search <語...> | meta <statsDataId> | load [--remote]");

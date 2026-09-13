// 過去分の一括投入（XIT001 → D1）。Worker の CPU 上限を避けるためローカルで回す。
//   npm run backfill -- --from 2010 --to 2025            # ローカル D1
//   npm run backfill -- --from 2010 --to 2025 --remote   # 本番 D1
//   npm run backfill -- --from 2024 --to 2024 --ward 40133 --remote     # 1 市区町村だけ
//   npm run backfill -- --from 2015 --to 2026 --scope suburb --remote   # 近郊 16 市町だけ（city = 福岡市の 7 区）
// (市区町村, 年, 四半期) ごとに DELETE → INSERT なので、何度流しても同じ結果になる。
import { fetchXit001, parseCondo, ReinfolibError } from "../src/reinfolib";
import { AREAS, areasInScope, parseScope } from "../src/wards";
import { executeSql, option, requireVar, sleep, sqlLit } from "./lib";

const SOURCE = "reinfolib:XIT001";
const wardOpt = option("ward");
const scopeOpt = option("scope");
if (scopeOpt !== undefined && !["city", "suburb", "all"].includes(scopeOpt)) {
  console.error(`--scope は city / suburb / all のどれかです（${scopeOpt}）`);
  process.exit(1);
}
const wards = wardOpt ? AREAS.filter((w) => w.code === wardOpt) : scopeOpt ? areasInScope(parseScope(scopeOpt)) : [...AREAS];
if (wards.length === 0) {
  console.error(`--ward ${wardOpt} は対象の市区町村コードではありません（src/wards.ts の AREAS を参照）`);
  process.exit(1);
}
const apiKey = requireVar("REINFOLIB_API_KEY");
const now = new Date();
const thisYear = now.getUTCFullYear();
const from = Math.max(2005, Number(option("from") ?? thisYear - 10));
const to = Math.min(thisYear, Number(option("to") ?? thisYear));

async function fetchWithRetry(year: number, quarter: number, city: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchXit001(apiKey, { year, quarter, city });
    } catch (e) {
      const retriable = e instanceof ReinfolibError && (e.status === 429 || e.status >= 500);
      if (!retriable || attempt >= 4) throw e;
      await sleep(2000 * attempt);
    }
  }
}

for (let year = from; year <= to; year++) {
  const stmts: string[] = [];
  for (let quarter = 1; quarter <= 4; quarter++) {
    if (year === 2005 && quarter < 3) continue;
    if (year === thisYear && quarter > Math.floor(now.getUTCMonth() / 3) + 1) continue;
    for (const w of wards) {
      const fetchedAt = new Date().toISOString();
      let status = "ok";
      let rows = 0;
      let error: string | null = null;
      try {
        const parsed = (await fetchWithRetry(year, quarter, w.code)).map(parseCondo).filter((x) => x !== null);
        rows = parsed.length;
        status = rows ? "ok" : "empty";
        stmts.push(`DELETE FROM transactions WHERE ward_code = ${sqlLit(w.code)} AND year = ${year} AND quarter = ${quarter}`);
        for (const t of parsed) {
          stmts.push(
            `INSERT INTO transactions (ward_code, year, quarter, price_category, district_name, district_code, trade_price, area_sqm, area_capped, unit_price, building_year, floor_plan, structure, renovation, city_planning, remarks) VALUES (` +
              [
                sqlLit(w.code), year, quarter, sqlLit(t.priceCategory), sqlLit(t.districtName), sqlLit(t.districtCode),
                t.tradePrice, sqlLit(t.areaSqm), t.areaCapped ? 1 : 0, sqlLit(t.unitPrice), sqlLit(t.buildingYear),
                sqlLit(t.floorPlan), sqlLit(t.structure), sqlLit(t.renovation), sqlLit(t.cityPlanning), sqlLit(t.remarks),
              ].join(", ") +
              ")",
          );
        }
      } catch (e) {
        status = "error";
        error = String(e instanceof Error ? e.message : e).slice(0, 500);
      }
      stmts.push(
        `INSERT INTO fetch_log (source, ward_code, year, quarter, status, rows, error, fetched_at) VALUES (${sqlLit(SOURCE)}, ${sqlLit(w.code)}, ${year}, ${quarter}, ${sqlLit(status)}, ${rows}, ${sqlLit(error)}, ${sqlLit(fetchedAt)}) ` +
          `ON CONFLICT (source, ward_code, year, quarter) DO UPDATE SET status = excluded.status, rows = excluded.rows, error = excluded.error, fetched_at = excluded.fetched_at`,
      );
      console.log(`${year}Q${quarter} ${w.name}: ${status} ${rows}件${error ? ` (${error})` : ""}`);
      await sleep(300); // 連続実行を避ける（API マニュアルの注意）
    }
  }
  executeSql(stmts, `backfill-${year}`);
}
console.log("完了");

import { hasReinfolibKey, type Env } from "./env";
import { fetchXit001, parseCondo, ReinfolibError } from "./reinfolib";
import { WARDS } from "./wards";

export const XIT001_SOURCE = "reinfolib:XIT001";

export interface Quarter {
  year: number;
  quarter: number;
}

/** now を含む四半期から遡って n 個（新しい順） */
export function recentQuarters(now: Date, n: number): Quarter[] {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const out: Quarter[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ year, quarter });
    quarter--;
    if (quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return out;
}

export interface IngestResult {
  wardCode: string;
  year: number;
  quarter: number;
  status: "ok" | "empty" | "error" | "no_key";
  rows: number;
  error?: string;
}

/**
 * 1 区 × 1 四半期を取り込む。(ward, year, quarter) の既存行を消して入れ直すので何度でも同じ結果になる。
 * DELETE と INSERT は 1 回の D1 batch（= 1 トランザクション）で行う。
 */
export async function ingestWardQuarter(env: Env, wardCode: string, q: Quarter): Promise<IngestResult> {
  const now = new Date().toISOString();
  const log = (r: IngestResult) =>
    env.DB.prepare(
      `INSERT INTO fetch_log (source, ward_code, year, quarter, status, rows, error, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (source, ward_code, year, quarter) DO UPDATE SET
         status = excluded.status, rows = excluded.rows, error = excluded.error, fetched_at = excluded.fetched_at`,
    ).bind(XIT001_SOURCE, wardCode, q.year, q.quarter, r.status, r.rows, r.error ?? null, now);

  if (!hasReinfolibKey(env)) {
    return { wardCode, ...q, status: "no_key", rows: 0 };
  }

  let records;
  try {
    records = await fetchXit001(env.REINFOLIB_API_KEY as string, { ...q, city: wardCode });
  } catch (e) {
    const msg = e instanceof ReinfolibError ? e.message : String(e);
    const r: IngestResult = { wardCode, ...q, status: "error", rows: 0, error: msg.slice(0, 500) };
    await log(r).run();
    return r;
  }

  const parsed = records.map(parseCondo).filter((x) => x !== null);
  const result: IngestResult = { wardCode, ...q, status: parsed.length ? "ok" : "empty", rows: parsed.length };

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM transactions WHERE ward_code = ? AND year = ? AND quarter = ?").bind(
      wardCode,
      q.year,
      q.quarter,
    ),
  ];
  const insert = env.DB.prepare(
    `INSERT INTO transactions (ward_code, year, quarter, price_category, district_name, district_code, trade_price,
       area_sqm, area_capped, unit_price, building_year, floor_plan, structure, renovation, city_planning, remarks)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const t of parsed) {
    stmts.push(
      insert.bind(
        wardCode, q.year, q.quarter, t.priceCategory, t.districtName, t.districtCode, t.tradePrice,
        t.areaSqm, t.areaCapped ? 1 : 0, t.unitPrice, t.buildingYear, t.floorPlan, t.structure,
        t.renovation, t.cityPlanning, t.remarks,
      ),
    );
  }
  stmts.push(log(result));
  await env.DB.batch(stmts);
  return result;
}

/** cron 1 回あたりに取る (区, 四半期) の上限。CPU 時間と subrequest 上限に余裕を持たせる */
export const CRON_BATCH = 3;
/** 公表の遅れと遡及修正を拾うため、直近何四半期を毎日取り直すか */
export const CRON_QUARTERS = 6;

/**
 * 日次 cron。直近 CRON_QUARTERS 四半期 × 7 区のうち「JST の今日まだ取っていないもの」を CRON_BATCH 件まで取る。
 * wrangler.toml で 5 分おきに 24 回起動するので（最大 72 件）、42 件は失敗の再試行込みで 1 日の中で取り切れる。
 */
export async function runDailyIngest(env: Env, now = new Date()): Promise<IngestResult[]> {
  if (!hasReinfolibKey(env)) {
    console.log("REINFOLIB_API_KEY 未設定のため取り込みをスキップ");
    return [];
  }
  const todayJstStartUtc = jstDayStartUtc(now).toISOString();
  const done = await env.DB.prepare(
    "SELECT ward_code, year, quarter FROM fetch_log WHERE source = ? AND fetched_at >= ? AND status IN ('ok','empty')",
  )
    .bind(XIT001_SOURCE, todayJstStartUtc)
    .all<{ ward_code: string; year: number; quarter: number }>();
  const doneKeys = new Set(done.results.map((r) => `${r.ward_code}:${r.year}:${r.quarter}`));

  const todo: { ward: string; q: Quarter }[] = [];
  for (const q of recentQuarters(now, CRON_QUARTERS)) {
    for (const w of WARDS) {
      if (!doneKeys.has(`${w.code}:${q.year}:${q.quarter}`)) todo.push({ ward: w.code, q });
    }
  }
  const results: IngestResult[] = [];
  for (const item of todo.slice(0, CRON_BATCH)) {
    results.push(await ingestWardQuarter(env, item.ward, item.q));
  }
  console.log(JSON.stringify({ ingest: results.map((r) => `${r.wardCode} ${r.year}Q${r.quarter} ${r.status} ${r.rows}`) }));
  return results;
}

export function jstDayStartUtc(now: Date): Date {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600_000);
}

export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

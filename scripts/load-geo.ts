// 不動産情報ライブラリのタイル API から「賃貸需要」の材料を取り込む（ローカル実行・REINFOLIB_API_KEY を使う）
//   npm run load-geo [-- --remote] [-- --only stations|future-pop]
//
// XKT015 駅別乗降客数: https://www.reinfolib.mlit.go.jp/help/apiManual/xkt015/
//   response_format=geojson, z=11..15, x, y。S12_001_ja 駅名 / S12_001c 駅コード / S12_002_ja 事業者 / S12_003_ja 路線
//   乗降客数は S12_009(2011), S12_013(2012) … 4 つ飛びで S12_057(2023)。以後の年も同じ規則で続く前提で、あるだけ読む。
// XKT013 将来推計人口 250m メッシュ: https://www.reinfolib.mlit.go.jp/help/apiManual/xkt013/
//   MESH_ID / SHICODE（市区町村コード）/ PT00_20XX（総人口）。SHICODE ごとに合計して区の値にする。
import { reinfolibGet } from "../src/reinfolib";
import { WARD_NAME } from "../src/wards";
import { executeSql, FUKUOKA_BBOX, option, requireVar, sleep, sqlLit, tilesForBbox } from "./lib";

const apiKey = requireVar("REINFOLIB_API_KEY");
const only = option("only");
const Z = 11;

interface Feature {
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown };
}

async function tileFeatures(apiId: string): Promise<Feature[]> {
  const out: Feature[] = [];
  for (const t of tilesForBbox(Z)) {
    const body = (await reinfolibGet(apiKey, apiId, {
      response_format: "geojson",
      z: String(t.z),
      x: String(t.x),
      y: String(t.y),
    })) as { features?: Feature[] } | null;
    const n = body?.features?.length ?? 0;
    console.log(`${apiId} z${t.z}/${t.x}/${t.y}: ${n} features`);
    if (body?.features) out.push(...body.features);
    await sleep(300);
  }
  return out;
}

function firstPoint(coords: unknown): [number, number] | null {
  let c = coords;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" ? [c[0], c[1]] : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

async function stations() {
  const features = await tileFeatures("XKT015");
  const seen = new Set<string>();
  const stmts: string[] = ["DELETE FROM station_passengers"];
  for (const f of features) {
    const p = f.properties ?? {};
    const code = str(p["S12_001c"]);
    const operator = str(p["S12_002_ja"]);
    const line = str(p["S12_003_ja"]);
    const name = str(p["S12_001_ja"]);
    const key = `${code}|${operator}|${line}`;
    if (!code || seen.has(key)) continue;
    const pt = firstPoint(f.geometry?.coordinates);
    if (!pt) continue;
    const [lon, lat] = pt;
    if (lon < FUKUOKA_BBOX.west || lon > FUKUOKA_BBOX.east || lat < FUKUOKA_BBOX.south || lat > FUKUOKA_BBOX.north) continue;
    seen.add(key);
    for (let i = 0, field = 9; ; i++, field += 4) {
      const k = `S12_${String(field).padStart(3, "0")}`;
      if (!(k in p)) break;
      const v = Number(p[k]);
      stmts.push(
        `INSERT INTO station_passengers (station_code, operator, line, name, lon, lat, year, passengers) VALUES (${sqlLit(code)}, ${sqlLit(operator)}, ${sqlLit(line)}, ${sqlLit(name)}, ${lon}, ${lat}, ${2011 + i}, ${Number.isFinite(v) && v > 0 ? Math.round(v) : "NULL"})`,
      );
    }
  }
  console.log(`駅（事業者・路線別）: ${seen.size}`);
  executeSql(stmts, "stations");
}

async function futurePop() {
  const features = await tileFeatures("XKT013");
  const seenMesh = new Set<string>();
  const sums = new Map<string, Map<string, number>>(); // SHICODE → year → 人口
  const otherCodes = new Set<string>();
  for (const f of features) {
    const p = f.properties ?? {};
    const mesh = str(p["MESH_ID"]);
    if (!mesh || seenMesh.has(mesh)) continue;
    seenMesh.add(mesh);
    const shi = str(p["SHICODE"]);
    if (!(shi in WARD_NAME)) {
      if (shi.startsWith("4013")) otherCodes.add(shi);
      continue;
    }
    const byYear = sums.get(shi) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(p)) {
      const m = k.match(/^PT00_(\d{4})$/);
      if (!m || !m[1]) continue;
      const n = Number(v);
      if (Number.isFinite(n)) byYear.set(m[1], (byYear.get(m[1]) ?? 0) + n);
    }
    sums.set(shi, byYear);
  }
  if (otherCodes.size) console.warn(`区コード以外の 4013x が SHICODE に出ました（集計対象外）: ${[...otherCodes].join(",")}`);
  if (sums.size === 0) {
    console.error("福岡市の区の SHICODE を持つメッシュがありませんでした。SHICODE の形式を確認してください。");
    return;
  }
  const now = new Date().toISOString();
  const stmts: string[] = [];
  for (const [ward, byYear] of sums) {
    for (const [year, value] of byYear) {
      stmts.push(
        `INSERT OR REPLACE INTO area_stats (area_level, area_code, indicator, period, value, unit, source, updated_at) VALUES ('ward', ${sqlLit(ward)}, 'future_pop', ${sqlLit(year)}, ${Math.round(value)}, '人', 'reinfolib:XKT013', ${sqlLit(now)})`,
      );
    }
    console.log(`${WARD_NAME[ward]}: ${[...byYear.entries()].map(([y, v]) => `${y}=${Math.round(v)}`).join(" ")}`);
  }
  executeSql(stmts, "future-pop");
}

if (!only || only === "stations") await stations();
if (!only || only === "future-pop") await futurePop();

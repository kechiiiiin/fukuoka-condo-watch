// 不動産情報ライブラリのタイル API から「賃貸需要」の材料を取り込む（ローカル実行・REINFOLIB_API_KEY を使う）
//   npm run load-geo [-- --remote] [-- --only stations|future-pop]
//
// XKT015 駅別乗降客数: https://www.reinfolib.mlit.go.jp/help/apiManual/xkt015/
//   response_format=geojson, z=11..15, x, y。S12_001_ja 駅名 / S12_001c 駅コード / S12_002_ja 事業者 / S12_003_ja 路線
//   乗降客数は S12_009(2011), S12_013(2012) … 4 つ飛びで S12_057(2023)。以後の年も同じ規則で続く前提で、あるだけ読む。
//   駅の位置（LineString の頂点の平均）を含む XKT013 のメッシュの SHICODE で市区町村にひも付ける（area_code・migrations/0004）。
// XKT013 将来推計人口 250m メッシュ: https://www.reinfolib.mlit.go.jp/help/apiManual/xkt013/
//   MESH_ID / SHICODE（市区町村コード）/ PT00_20XX（総人口・2025〜2070）/ PTN_2020（2020 年の国勢調査人口）。
//   ⚠️ 2020 年は PT00_2020 ではなく PTN_2020 にある（2026-09-14 に実レスポンスのキーで確認）。これを読まないと
//      src/metrics.ts の「将来人口の増減 2020→2040」が全市区町村で空になる。
//   SHICODE ごとに合計して市区町村の値にする。対象は src/wards.ts の AREAS。範囲は scripts/lib.ts の FUKUOKA_BBOX。
import { reinfolibGet } from "../src/reinfolib";
import { AREAS, AREA_NAME, isAreaCode } from "../src/wards";
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

/** 座標列（Point / LineString / Polygon …）の全頂点 */
function vertices(coords: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
    out.push([coords[0], coords[1]]);
  } else if (Array.isArray(coords)) {
    for (const c of coords) vertices(c, out);
  }
  return out;
}

/** 頂点の平均（駅の LineString は短いので、これをホームの位置とみなす） */
function center(coords: unknown): [number, number] | null {
  const vs = vertices(coords);
  if (vs.length === 0) return null;
  const lon = vs.reduce((s, v) => s + v[0], 0) / vs.length;
  const lat = vs.reduce((s, v) => s + v[1], 0) / vs.length;
  return [lon, lat];
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** SHICODE を 5 桁に揃える（検査数字付きの 6 桁で来た場合に備える） */
const normalizeShicode = (s: string) => (/^\d{6}$/.test(s) ? s.slice(0, 5) : s);

interface Mesh {
  id: string;
  shi: string;
  west: number;
  east: number;
  south: number;
  north: number;
  props: Record<string, unknown>;
}

/** XKT013 のメッシュ（重複除去済み）。タイルの境目で同じメッシュが複数回来る */
async function loadMeshes(): Promise<Mesh[]> {
  const features = await tileFeatures("XKT013");
  const seen = new Set<string>();
  const out: Mesh[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const id = str(p["MESH_ID"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const vs = vertices(f.geometry?.coordinates);
    if (vs.length === 0) continue;
    out.push({
      id,
      shi: normalizeShicode(str(p["SHICODE"])),
      west: Math.min(...vs.map((v) => v[0])),
      east: Math.max(...vs.map((v) => v[0])),
      south: Math.min(...vs.map((v) => v[1])),
      north: Math.max(...vs.map((v) => v[1])),
      props: p,
    });
  }
  return out;
}

/** 点を含むメッシュの市区町村。無ければ（人口 0 のメッシュは収録されない）中心が 約 500m 以内で最も近いメッシュ */
function areaOf(meshes: Mesh[], lon: number, lat: number): string | null {
  const hit = meshes.find((m) => lon >= m.west && lon <= m.east && lat >= m.south && lat <= m.north);
  let shi = hit?.shi ?? null;
  if (!hit) {
    let best = 0.005 ** 2;
    for (const m of meshes) {
      const d = ((m.west + m.east) / 2 - lon) ** 2 + ((m.south + m.north) / 2 - lat) ** 2;
      if (d < best) {
        best = d;
        shi = m.shi;
      }
    }
  }
  return shi && isAreaCode(shi) ? shi : null;
}

async function stations(meshes: Mesh[]) {
  const features = await tileFeatures("XKT015");
  const seen = new Set<string>();
  const perArea = new Map<string, number>();
  const stmts: string[] = ["DELETE FROM station_passengers"];
  for (const f of features) {
    const p = f.properties ?? {};
    const code = str(p["S12_001c"]);
    const operator = str(p["S12_002_ja"]);
    const line = str(p["S12_003_ja"]);
    const name = str(p["S12_001_ja"]);
    const key = `${code}|${operator}|${line}`;
    if (!code || seen.has(key)) continue;
    const pt = center(f.geometry?.coordinates);
    if (!pt) continue;
    const [lon, lat] = pt;
    if (lon < FUKUOKA_BBOX.west || lon > FUKUOKA_BBOX.east || lat < FUKUOKA_BBOX.south || lat > FUKUOKA_BBOX.north) continue;
    seen.add(key);
    const area = areaOf(meshes, lon, lat);
    if (area) perArea.set(area, (perArea.get(area) ?? 0) + 1);
    for (let i = 0, field = 9; ; i++, field += 4) {
      const k = `S12_${String(field).padStart(3, "0")}`;
      if (!(k in p)) break;
      const v = Number(p[k]);
      stmts.push(
        `INSERT INTO station_passengers (station_code, operator, line, name, lon, lat, year, passengers, area_code) VALUES (${sqlLit(code)}, ${sqlLit(operator)}, ${sqlLit(line)}, ${sqlLit(name)}, ${lon}, ${lat}, ${2011 + i}, ${Number.isFinite(v) && v > 0 ? Math.round(v) : "NULL"}, ${sqlLit(area)})`,
      );
    }
  }
  console.log(`駅（事業者・路線別）: ${seen.size}`);
  console.log(`市区町村にひも付いた駅: ${AREAS.map((a) => `${a.name}=${perArea.get(a.code) ?? 0}`).join(" ")}`);
  executeSql(stmts, "stations");
}

async function futurePop(meshes: Mesh[]) {
  const sums = new Map<string, Map<string, number>>(); // SHICODE → year → 人口
  const otherCodes = new Set<string>();
  for (const m of meshes) {
    if (!isAreaCode(m.shi)) {
      if (m.shi) otherCodes.add(m.shi);
      continue;
    }
    const byYear = sums.get(m.shi) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(m.props)) {
      const hit = k.match(/^PT00_(\d{4})$/) ?? (k === "PTN_2020" ? [k, "2020"] : null);
      if (!hit || !hit[1]) continue;
      const n = Number(v);
      if (Number.isFinite(n)) byYear.set(hit[1], (byYear.get(hit[1]) ?? 0) + n);
    }
    sums.set(m.shi, byYear);
  }
  if (otherCodes.size) console.log(`対象外の SHICODE（範囲の端にかかった周辺市町村。集計しない）: ${[...otherCodes].sort().join(",")}`);
  if (sums.size === 0) {
    console.error("対象市区町村の SHICODE を持つメッシュがありませんでした。SHICODE の形式を確認してください。");
    return;
  }
  const missing = AREAS.filter((a) => !sums.has(a.code));
  if (missing.length) {
    console.warn(`⚠️ メッシュが 1 つも無かった市区町村: ${missing.map((a) => `${a.name}(${a.code})`).join(",")} — FUKUOKA_BBOX が足りない可能性`);
  }
  const no2020 = [...sums.entries()].filter(([, y]) => !y.has("2020")).map(([c]) => AREA_NAME[c]);
  if (no2020.length) console.warn(`⚠️ PTN_2020（2020 年人口）が無かった市区町村: ${no2020.join(",")}`);
  const now = new Date().toISOString();
  const stmts: string[] = [];
  for (const [code, byYear] of sums) {
    for (const [year, value] of byYear) {
      stmts.push(
        `INSERT OR REPLACE INTO area_stats (area_level, area_code, indicator, period, value, unit, source, updated_at) VALUES ('municipality', ${sqlLit(code)}, 'future_pop', ${sqlLit(year)}, ${Math.round(value)}, '人', 'reinfolib:XKT013', ${sqlLit(now)})`,
      );
    }
    const ys = [...byYear.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    console.log(`${AREA_NAME[code]}: ${ys.map(([y, v]) => `${y}=${Math.round(v)}`).join(" ")}`);
  }
  executeSql(stmts, "future-pop");
}

// 駅のひも付けにも XKT013 のメッシュを使うので、どちらを取るときも先に読む
const meshes = await loadMeshes();
console.log(`XKT013 メッシュ: ${meshes.length}`);
if (!only || only === "stations") await stations(meshes);
if (!only || only === "future-pop") await futurePop(meshes);

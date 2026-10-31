// バス直通マップ（/listings/bus）のデータを作る。判定の規則は scripts/bus-access-lib.ts。
//   npm run bus:build -- --p11 <P11-22_40.geojson | P11-22_40_SHP の展開先 | P11-22_40_SHP.zip> --n03 <N03-23_40_230101.geojson | 展開先 | zip>
//   出力: src/data/bus-access.json（--out で変更可）
//
// 入力（国土数値情報。ダウンロードは手で。データ内のスクリプトは実行しない）
//   P11 バス停留所 2022年度 福岡県: https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_40_SHP.zip
//     P11_001 停留所名 / P11_002 事業者名 / P11_003_01〜35 系統名（長い 1 本の文字列をカンマ区切りで分けて入れてある）
//   N03 行政区域 2023年 福岡県: https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2023/N03-20230101_40_GML.zip
//     N03_007 全国地方公共団体コード。バス停の座標がどの市区町村のポリゴンに入るかで範囲を決める（福岡市7区＋糸島市）
//   zip を渡したときは $TMPDIR 配下の空ディレクトリへ unzip して中の *.geojson を読む
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AREA_LABELS,
  type BusAccessData,
  type BusAccessStop,
  DESTINATIONS,
  destinationKeySets,
  FUKUOKA_CITY_CODES,
  ITOSHIMA_CODE,
  ITOSHIMA_RADIUS_M,
  ITOSHIMA_STATIONS,
  judgeStop,
  nearItoshimaStation,
  splitRouteField,
  type StopInput,
} from "./bus-access-lib";
import { option } from "./lib";

const p11Arg = option("p11");
const n03Arg = option("n03");
const outPath = option("out") ?? "src/data/bus-access.json";
if (!p11Arg || !n03Arg) {
  console.error("usage: npm run bus:build -- --p11 <geojson|dir|zip> --n03 <geojson|dir|zip> [--out src/data/bus-access.json]");
  process.exit(1);
}

/** geojson ファイル・展開先ディレクトリ・zip のどれでも受けて、geojson のパスを返す */
function resolveGeojson(p: string, prefix: string): string {
  let dir = p;
  if (p.endsWith(".zip")) {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `${prefix}-`));
    execFileSync("unzip", ["-q", "-o", p, "-d", dir]);
  } else if (statSync(p).isFile()) {
    return p;
  }
  const found: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (f.endsWith(".geojson") && f.startsWith(prefix)) found.push(full);
    }
  };
  walk(dir);
  if (found.length !== 1) throw new Error(`${prefix}*.geojson が ${dir} に 1 つだけ見つかりません（${found.length} 件）`);
  return found[0]!;
}

type Ring = number[][];
interface Feature {
  properties: Record<string, string | null>;
  geometry: { type: string; coordinates: unknown } | null;
}

// ---- 行政区域（N03）: ポリゴンごとに bbox を持たせて点の内外判定 ----
interface AreaPoly {
  code: string;
  rings: Ring[]; // [外周, 穴...]
  bbox: [number, number, number, number];
}
function loadAreas(path: string): AreaPoly[] {
  const fc = JSON.parse(readFileSync(path, "utf8")) as { features: Feature[] };
  const want = new Set<string>([...FUKUOKA_CITY_CODES, ITOSHIMA_CODE]);
  const out: AreaPoly[] = [];
  for (const f of fc.features) {
    const code = f.properties.N03_007;
    if (!code || !want.has(code) || !f.geometry) continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates as Ring[]] : (f.geometry.coordinates as Ring[][]);
    for (const rings of polys) {
      const outer = rings[0]!;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of outer) {
        x0 = Math.min(x0, x!);
        y0 = Math.min(y0, y!);
        x1 = Math.max(x1, x!);
        y1 = Math.max(y1, y!);
      }
      out.push({ code, rings, bbox: [x0, y0, x1, y1] });
    }
  }
  return out;
}
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function areaOf(areas: AreaPoly[], lng: number, lat: number): string | null {
  for (const a of areas) {
    const [x0, y0, x1, y1] = a.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (!inRing(lng, lat, a.rings[0]!)) continue;
    if (a.rings.slice(1).some((h) => inRing(lng, lat, h))) continue;
    return a.code;
  }
  return null;
}

// ---- バス停（P11）: 同名・同座標の事業者違いを 1 点にまとめる ----
function loadStops(path: string): StopInput[] {
  const fc = JSON.parse(readFileSync(path, "utf8")) as { features: Feature[] };
  const byPoint = new Map<string, StopInput>();
  for (const f of fc.features) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const name = f.properties.P11_001 ?? "";
    const operator = f.properties.P11_002 ?? "";
    const fields: (string | null)[] = [];
    for (let i = 1; i <= 35; i++) fields.push(f.properties[`P11_003_${String(i).padStart(2, "0")}`] ?? null);
    const id = `${name}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
    const s = byPoint.get(id) ?? { name, lat, lng, routes: [] };
    for (const raw of splitRouteField(fields)) s.routes.push({ operator, raw });
    byPoint.set(id, s);
  }
  return [...byPoint.values()];
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

const stops = loadStops(resolveGeojson(p11Arg, "P11"));
const areas = loadAreas(resolveGeojson(n03Arg, "N03"));
const sets = destinationKeySets(stops); // 目的地バス停は範囲外の市町村も含め全県から拾う

const operators: string[] = [];
const opIndex = (o: string) => {
  let i = operators.indexOf(o);
  if (i < 0) i = operators.push(o) - 1;
  return i;
};

const out: BusAccessStop[] = [];
let skippedItoshima = 0;
for (const s of stops) {
  const area = areaOf(areas, s.lng, s.lat);
  if (!area) continue;
  if (area === ITOSHIMA_CODE && !nearItoshimaStation(s.lat, s.lng)) {
    skippedItoshima++;
    continue;
  }
  const j = judgeStop(s, sets);
  let f = 0;
  let d = 0;
  DESTINATIONS.forEach((dest, i) => {
    if (j.reach[dest.key]) f |= 1 << i;
    if (j.isDest[dest.key]) d |= 1 << i;
  });
  out.push({
    n: s.name,
    lat: round5(s.lat),
    lng: round5(s.lng),
    o: [...new Set(s.routes.map((r) => r.operator))].map(opIndex),
    a: area,
    f,
    d,
    r: DESTINATIONS.map((dest) => j.matched[dest.key]),
  });
}
out.sort((x, y) => x.lat - y.lat || x.lng - y.lng || x.n.localeCompare(y.n));

const data: BusAccessData = {
  source: "国土数値情報（バス停留所データ）国土交通省 2022年度 を加工して作成",
  generatedAt: new Date().toISOString().slice(0, 10),
  destinations: DESTINATIONS.map((d) => ({ ...d, stops: sets[d.key].stops })),
  itoshimaStations: ITOSHIMA_STATIONS.map((s) => ({ ...s })),
  itoshimaRadiusM: ITOSHIMA_RADIUS_M,
  operators,
  stops: out,
};
const body = JSON.stringify(data);
writeFileSync(outPath, body + "\n");
console.log(`wrote ${outPath}: ${out.length} stops, ${(body.length / 1024).toFixed(0)} KiB（糸島市の駅から ${ITOSHIMA_RADIUS_M}m 外で除外 ${skippedItoshima}）`);
for (const d of DESTINATIONS) console.log(`  目的地バス停 ${d.label}: ${sets[d.key].stops.join("・")}（系統キー ${sets[d.key].keys.size}）`);
for (const [code, label] of Object.entries(AREA_LABELS)) console.log(`  ${label}: ${out.filter((s) => s.a === code).length}`);

// src/data/bus-access.json の検算（build-bus-access.ts の出力を、作り方と独立に確かめる）
//   npm run bus:check [-- --n03 <N03-23_40_230101.geojson>]
//   (a) 目的地バス停は自分の目的地フラグが true
//   (b) 件数・目的地ごとの true 件数・3 つ全部 true の件数
//   (c) 既知のバス停名（祇園町・東比恵一丁目・天神四丁目 など）が入っている
//   (d) 座標がすべて福岡市＋糸島の範囲内（区・市コードが範囲のもの／矩形の外が無い／糸島市は 3 駅から 2km 以内）
//       --n03 を渡すと、行政区域ポリゴンに入るかも数える（ポリゴンの判定は build と同じ方法なので、ここでは件数の再確認）
import { readFileSync } from "node:fs";
import { AREA_LABELS, type BusAccessData, distanceM, ITOSHIMA_CODE } from "./bus-access-lib";
import { option } from "./lib";

const data = JSON.parse(readFileSync(option("data") ?? "src/data/bus-access.json", "utf8")) as BusAccessData;
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "OK  " : "NG  "} ${label}`);
  if (!ok) failures.push(label);
};

const { stops, destinations } = data;
console.log(`出典: ${data.source}（生成 ${data.generatedAt}）`);

// (a)
destinations.forEach((d, i) => {
  const own = stops.filter((s) => (s.d >> i) & 1);
  const bad = own.filter((s) => !((s.f >> i) & 1));
  check(own.length > 0 && bad.length === 0, `(a) ${d.label}: 目的地バス停 ${own.length} 点がすべて「直通あり」${bad.length ? `（NG: ${bad.map((s) => s.n).join("・")}）` : ""}`);
  // 目的地バス停の判定（d の bit）は半径の内側と一致するか
  const inside = stops.filter((s) => distanceM(s.lat, s.lng, d.lat, d.lng) <= d.radiusM + 2);
  check(inside.length >= own.length, `(a) ${d.label}: 半径 ${d.radiusM}m 内のバス停 ${inside.length} 点 ≥ 目的地印 ${own.length} 点`);
});

// (b)
console.log(`\n(b) バス停（点）: ${stops.length}`);
destinations.forEach((d, i) => console.log(`    ${d.label} へ直通あり: ${stops.filter((s) => (s.f >> i) & 1).length}`));
const all = (1 << destinations.length) - 1;
console.log(`    3 つ全部: ${stops.filter((s) => s.f === all).length}`);
for (let k = 0; k <= destinations.length; k++) {
  const n = stops.filter((s) => [0, 1, 2].filter((i) => (s.f >> i) & 1).length === k).length;
  console.log(`    直通できる目的地の数 ${k}: ${n}`);
}
check(stops.length > 500, "(b) 件数が 500 点を超える（福岡市全域として少なすぎない）");

// (c)
console.log("");
for (const name of ["祇園町", "東比恵一丁目", "天神四丁目", "博多駅", "前原駅南口", "姪浜駅南口"]) {
  const hit = stops.filter((s) => s.n === name);
  const flags = hit.map((s) => destinations.map((d, i) => `${d.label}${(s.f >> i) & 1 ? "○" : "×"}`).join(" ")).join(" / ");
  check(hit.length > 0, `(c) 「${name}」がある（${hit.length} 点${flags ? `: ${flags}` : ""}）`);
}

// (d)
console.log("");
const codes = new Set(Object.keys(AREA_LABELS));
check(stops.every((s) => codes.has(s.a)), "(d) 全点の区・市コードが福岡市7区か糸島市");
// 福岡市＋糸島市の外接矩形（N03 から目で確かめた範囲に余裕を持たせた値。島しょ部の玄界島・小呂島を含む）
const BOX = { latMin: 33.43, latMax: 33.88, lngMin: 129.9, lngMax: 130.5 };
const outBox = stops.filter((s) => s.lat < BOX.latMin || s.lat > BOX.latMax || s.lng < BOX.lngMin || s.lng > BOX.lngMax);
check(outBox.length === 0, `(d) 全点が矩形 ${JSON.stringify(BOX)} の内側${outBox.length ? `（外: ${outBox.map((s) => s.n).join("・")}）` : ""}`);
const ito = stops.filter((s) => s.a === ITOSHIMA_CODE);
const far = ito.filter((s) => !data.itoshimaStations.some((st) => distanceM(s.lat, s.lng, st.lat, st.lng) <= data.itoshimaRadiusM + 2));
check(far.length === 0, `(d) 糸島市の ${ito.length} 点はすべて ${data.itoshimaStations.map((s) => s.name).join("・")} 駅から ${data.itoshimaRadiusM}m 以内`);
for (const [code, label] of Object.entries(AREA_LABELS)) console.log(`    ${label}: ${stops.filter((s) => s.a === code).length}`);

const n03 = option("n03");
if (n03) {
  // 行政区域ポリゴンで、点が付いている区・市コードのポリゴンに本当に入っているか
  type Ring = number[][];
  const fc = JSON.parse(readFileSync(n03, "utf8")) as { features: { properties: Record<string, string | null>; geometry: { type: string; coordinates: unknown } }[] };
  const polys = new Map<string, Ring[][]>();
  for (const f of fc.features) {
    const c = f.properties.N03_007;
    if (!c || !codes.has(c)) continue;
    const list = polys.get(c) ?? [];
    if (f.geometry.type === "Polygon") list.push(f.geometry.coordinates as Ring[]);
    else list.push(...(f.geometry.coordinates as Ring[][]));
    polys.set(c, list);
  }
  const inRing = (x: number, y: number, r: Ring) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i] as [number, number];
      const [xj, yj] = r[j] as [number, number];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // 座標は小数 5 桁に丸めてあるので、境界ぎわの数点が外に出るのは許す（約 1m）
  const outside = stops.filter((s) => !(polys.get(s.a) ?? []).some((rings) => inRing(s.lng, s.lat, rings[0]!) && !rings.slice(1).some((h) => inRing(s.lng, s.lat, h))));
  check(outside.length <= 3, `(d) 行政区域ポリゴン（N03）の内側: 外れ ${outside.length} 点${outside.length ? `（${outside.map((s) => s.n).join("・")}）` : ""}`);
}

if (failures.length) {
  console.error(`\n${failures.length} 件 NG`);
  process.exit(1);
}
console.log("\nすべて OK");

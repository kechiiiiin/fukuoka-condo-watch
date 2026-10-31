// src/data/bus-routes.json（scripts/collect-nnr-routes.ts の出力）の検算。
//   node --import tsx scripts/check-nnr-routes.ts [--in src/data/bus-routes.json]
// 期待値は西鉄の公式検索で確かめたもの（直通あり / 直通なし）。外れたら収集側を直す。
import { readFileSync } from "node:fs";
import { option } from "./lib";

type Stop = { name: string; lat: number | null; lng: number | null; city?: string; coordSource: string | null; dests: string[]; numbers: string[]; higashiStops?: string[] };
type Route = { dest: string; destStop?: string; number: string; direction: string; destIndex: number; stops: { name: string; passThrough?: true }[] };
type Found = { dest: string; destStop: string; terminus: string; platform: string; keitoCd: string; numbers: string[]; newStops: number };
const data = JSON.parse(readFileSync(option("in") ?? "src/data/bus-routes.json", "utf8")) as {
  stops: Stop[];
  routes: Route[];
  meta: { platformFix?: { found: Found[]; coveredByExistingKeito: string[] } };
};
/** その停留所から通勤の向きで直通できる higashi の便（降りるバス停と系統番号） */
const higashiVia = (name: string) =>
  data.routes
    .filter((r) => r.dest === "higashi" && r.direction === "to_dest" && r.stops.slice(0, r.destIndex).some((s) => s.name === name && !s.passThrough))
    .map((r) => `${r.destStop}:${r.number}`);

let failed = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};
const find = (name: string, dest: string) => data.stops.filter((s) => s.name === name && s.dests.includes(dest));
const where = (ss: Stop[]) => ss.map((s) => `${s.city ?? "?"} ${s.lat?.toFixed(4)},${s.lng?.toFixed(4)} [${s.numbers.join(",")}]`).join(" / ");

// (a) 祇園町へ直通
{
  const hirata = find("平田", "gion");
  // 早良区の平田: 停留所名検索の city、無ければ座標（早良区の平田は 33.53〜33.56N・130.32〜130.36E あたり）
  const sawara = hirata.filter((s) => s.city === "福岡市早良区" || (s.city === undefined && s.lat !== null && s.lat > 33.5 && s.lat < 33.58 && s.lng! > 130.3 && s.lng! < 130.38));
  ok(sawara.length > 0, "(a) 平田（早良区） が gion", where(hirata));
}
for (const n of ["田隈小学校前", "香椎", "千早公園前", "すの子", "南片江六丁目"]) {
  const ss = find(n, "gion");
  ok(ss.length > 0, `(a) ${n} が gion`, where(ss));
}
// (b) 学校近くへ直通（半道橋 → 東比恵二丁目 は公式検索で直通あり。東光二丁目へは直通なし）
{
  const ss = find("半道橋", "higashi");
  ok(ss.some((s) => s.higashiStops?.includes("東比恵二丁目")), "(b) 半道橋 が higashi（東比恵二丁目経由）", ss.map((s) => `降りる: ${s.higashiStops?.join("・")}`).join(" / "));
}
// 参考（合否にしない）: 東比恵二丁目へは公式検索で直通なし。学校近くの他のバス停へ入ったか
for (const n of ["八田", "大濠公園", "金隈遺跡前", "土井団地"]) {
  const ss = find(n, "higashi");
  console.log(`参考 ${n}: ${ss.length ? `入った  降りる:系統 ${[...new Set(higashiVia(n))].join(", ")}` : "入らなかった"}`);
}
// (c) 祇園町へ直通が無い（公式検索で確認済み）
for (const n of ["椎原", "福大病院", "雁の巣", "西月隈三丁目"]) {
  const ss = find(n, "gion");
  ok(ss.length === 0, `(c) ${n} が gion に入っていない`, ss.length ? where(ss) : "");
}
// (d) 座標
{
  const withCoord = data.stops.filter((s) => s.lat !== null && s.lng !== null);
  // 福岡県の外接矩形（おおよそ 33.0〜34.3N・129.9〜131.2E）
  const outside = withCoord.filter((s) => !(s.lat! > 33.0 && s.lat! < 34.3 && s.lng! > 129.9 && s.lng! < 131.2));
  ok(outside.length === 0, "(d) 座標が福岡県内", outside.map((s) => `${s.name} ${s.lat},${s.lng}`).join(" / "));
  const missing = data.stops.filter((s) => s.lat === null);
  const bySource = data.stops.reduce<Record<string, number>>((a, s) => ((a[s.coordSource ?? "なし"] = (a[s.coordSource ?? "なし"] ?? 0) + 1), a), {});
  console.log(`     座標の出典: ${JSON.stringify(bySource)}  座標なし ${missing.length} 件${missing.length ? `: ${missing.map((s) => s.name).join("、")}` : ""}`);
}
// 参考: 行先名が合わず抜けていた行先を乗り場名で補った系統（行先・使った乗り場名・系統番号・増えた直通バス停の数）
if (data.meta.platformFix) {
  console.log("補った系統:");
  console.log("     （降りるバス停  行先 ← 使った乗り場  系統番号(keito)  増えた直通バス停＝その降りるバス停へ前回まで行けなかった停留所の数）");
  for (const f of data.meta.platformFix.found) console.log(`     ${f.destStop}  ${f.terminus} ← ${f.platform}  ${f.numbers.join(",")}(${f.keitoCd})  +${f.newStops}`);
  if (data.meta.platformFix.coveredByExistingKeito.length) console.log(`     直通は出たが系統が既存と同じ（新しい系統なし）: ${data.meta.platformFix.coveredByExistingKeito.join("、")}`);
}
console.log(`stops ${data.stops.length} / routes ${data.routes.length} / NG ${failed}`);
process.exit(failed ? 1 : 0);

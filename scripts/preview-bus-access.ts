// /listings/bus の HTML をローカルに書き出す（Access を通さずに地図を確かめる用）
//   npm run bus:preview [-- --out <path>]   既定は $TMPDIR/bus-preview.html
// データは HTML に埋め込み済みなので、書き出したファイルをブラウザで開けばそのまま地図（OSM タイル・Leaflet は CDN）が出る
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBusAccessDashboard } from "../src/bus-access-dashboard";
import { option } from "./lib";

const out = option("out") ?? join(process.env.TMPDIR ?? tmpdir(), "bus-preview.html");
writeFileSync(out, renderBusAccessDashboard());
console.log(`wrote ${out}`);

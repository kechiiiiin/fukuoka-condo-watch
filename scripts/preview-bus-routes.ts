// /listings/bus の HTML をローカルに書き出す（Access を通さずに地図を確かめる用）
//   npm run bus:preview [-- --out <path>]   既定は $TMPDIR/bus-routes-preview.html
// データは HTML に埋め込み済みなので、書き出したファイルをブラウザで開けばそのまま地図（OSM タイル・Leaflet は CDN）が出る
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBusRoutesDashboard } from "../src/bus-routes-dashboard";
import { option } from "./lib";

const out = option("out") ?? join(process.env.TMPDIR ?? tmpdir(), "bus-routes-preview.html");
const html = renderBusRoutesDashboard();
writeFileSync(out, html);
const m = html.match(/var DATA = (\{.*?\});\n/s);
console.log(`wrote ${out}（HTML ${(Buffer.byteLength(html) / 1024).toFixed(0)}KB・埋め込みデータ ${m ? (Buffer.byteLength(m[1]!) / 1024).toFixed(0) : "?"}KB）`);

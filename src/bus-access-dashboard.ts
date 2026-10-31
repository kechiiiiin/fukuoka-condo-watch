// /listings/bus（非公開・Cloudflare Access 保護）。「バス直通マップ」。
// 福岡市全域＋糸島市（筑肥線 波多江・糸島高校前・筑前前原の各駅から 2km）のバス停を、
// 天神・祇園（職場）・東福岡（長男の学校）へ乗り換えなしで行ける系統があるかで色分けする。
// データは src/data/bus-access.json（scripts/build-bus-access.ts で国土数値情報 P11 から作る・判定の規則は scripts/bus-access-lib.ts）。
// 1200 点ほど・200KB 余りなので API にせず HTML に埋め込む（静的に保存してもそのまま開ける）。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

import busData from "./data/bus-access.json";

export function renderBusAccessDashboard(): string {
  return HTML;
}

export const LEAFLET_VERSION = "1.9.4";
const LEAFLET = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}`;
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const DATA_JSON = safeJson(busData);
const SOURCE = (busData as { source: string }).source;

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>バス直通マップ（非公開）</title>
<link rel="stylesheet" href="${LEAFLET}/leaflet.min.css">
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309;
          --c0:#c8ccd2; --c1:#93c5fd; --c2:#3b82f6; --c3:#1e3a8a; --dest:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b;
          --c0:#4b5563; --c1:#1e40af; --c2:#3b82f6; --c3:#bfdbfe; --dest:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 1100px; margin: 0 auto; padding: 10px 14px; }
  h1 { font-size: 1.2rem; margin: 6px 0 2px; }
  a { color: var(--accent); }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 4px 10px; margin: 6px 0 0; border-radius: 4px; font-size: .82rem; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 8px 0 6px; }
  .bar .lbl { font-size: .8rem; color: var(--muted); }
  .checks { display: inline-flex; align-items: center; gap: 4px; font-size: .9rem; }
  .checks input { width: 18px; height: 18px; }
  .count { font-size: .82rem; color: var(--muted); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .8rem; color: var(--muted); }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.25); }
  .legend .dest { border-radius: 2px; background: var(--dest); }
  #map { height: calc(100vh - 230px); min-height: 380px; border: 1px solid var(--line); border-radius: 10px; }
  @media (max-width: 600px) { #map { height: 68vh; } main { padding: 4px 6px; } }
  @media (prefers-color-scheme: dark) { #map .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(.85) contrast(.9); } }
  .leaflet-popup-content { font-size: .85rem; line-height: 1.5; margin: 10px 12px; }
  .leaflet-popup-content b.name { font-size: .95rem; }
  .pop-ops { color: #667085; font-size: .78rem; }
  .pop-dest { margin-top: 4px; }
  .pop-dest .no { color: #9aa3af; }
  .destlabel { background: var(--dest); color: #fff; font-size: 11px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  .stlabel { background: #fff; color: #1f2328; border: 1px solid #1f2328; font-size: 10px; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
</style>
<script src="${LEAFLET}/leaflet.min.js"></script>
</head>
<body>
<header>
  <h1>バス直通マップ（非公開）</h1>
  <div class="sub"><a href="/listings">← 掲載ウォッチ全体</a> ・<a href="/listings/picks">条件に合う物件 →</a> ／ 天神・祇園（職場）・東福岡（学校）へ乗り換えなしで行けるバス停</div>
  <div class="notice">2022年時点の公開データから系統番号の一致で推定。方向・経由の違いは区別していない。西鉄の公式検索での確認が前提。</div>
  <div class="bar" id="checks">
    <span class="lbl">直通で行きたい先（すべてに行ける停留所を強調）</span>
    <label class="checks"><input type="checkbox" id="cb-0" checked> 天神</label>
    <label class="checks"><input type="checkbox" id="cb-1" checked> 祇園</label>
    <label class="checks"><input type="checkbox" id="cb-2" checked> 東福岡</label>
    <span class="count" id="count"></span>
  </div>
  <div class="legend" id="legend">
    <span>直通できる目的地の数:</span>
    <span><i style="background:var(--c0)"></i>0</span>
    <span><i style="background:var(--c1)"></i>1</span>
    <span><i style="background:var(--c2)"></i>2</span>
    <span><i style="background:var(--c3)"></i>3</span>
    <span><i class="dest"></i>目的地（円は目的地バス停の範囲）</span>
    <span>□ 筑肥線の駅（糸島市は駅から2kmだけ）</span>
  </div>
</header>
<main>
  <div id="map"></div>
</main>
<footer class="sub">出典: ${SOURCE}。地図: © OpenStreetMap contributors。目的地バス停 = 天神は地下鉄天神駅・西鉄福岡（天神）駅の中点から600m、祇園は祇園NKビルから400m、東福岡は東福岡高校（博多区東比恵2丁目24-1）から500m のバス停。系統名は事業者ごとに番号へ正規化（快速・急行・［区間］などを除き「・」で分割）して照合。</footer>
<script>
var DATA = ${DATA_JSON};
(function () {
  var css = getComputedStyle(document.documentElement);
  var COLORS = [0, 1, 2, 3].map(function (i) { return css.getPropertyValue("--c" + i).trim() || ["#c8ccd2", "#93c5fd", "#3b82f6", "#1e3a8a"][i]; });
  var DEST_COLOR = css.getPropertyValue("--dest").trim() || "#dc2626";
  var NDEST = DATA.destinations.length;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function bitCount(f) { var n = 0; for (var i = 0; i < NDEST; i++) if ((f >> i) & 1) n++; return n; }

  var map = L.map("map", { preferCanvas: true, zoomControl: true });
  // 島しょ部（玄界島・能古島など）まで入れると引きすぎるので、市街地〜前原の範囲に合わせる
  map.fitBounds([[33.52, 130.19], [33.69, 130.48]]);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.attributionControl.addAttribution("国土数値情報（バス停留所）国土交通省");

  function popupHtml(s) {
    var ops = s.o.map(function (i) { return DATA.operators[i]; }).join("・");
    var h = '<b class="name">' + esc(s.n) + '</b><div class="pop-ops">' + esc(ops) + "</div>";
    DATA.destinations.forEach(function (d, i) {
      var ok = (s.f >> i) & 1;
      var routes = s.r[i] || [];
      h += '<div class="pop-dest">' + (ok ? "○ " : '<span class="no">× ') + esc(d.label) + (ok ? "" : "</span>");
      if (ok && routes.length) h += "：" + routes.map(esc).join("、");
      if ((s.d >> i) & 1) h += "（目的地バス停）";
      h += "</div>";
    });
    return h;
  }

  var markers = DATA.stops.map(function (s) {
    var m = L.circleMarker([s.lat, s.lng], { radius: 5, weight: 1, color: "#00000055", fillColor: COLORS[bitCount(s.f)], fillOpacity: 0.9 });
    m.bindPopup(function () { return popupHtml(s); });
    m.addTo(map);
    return m;
  });

  DATA.destinations.forEach(function (d) {
    L.circle([d.lat, d.lng], { radius: d.radiusM, color: DEST_COLOR, weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
    L.marker([d.lat, d.lng], { icon: L.divIcon({ className: "", html: '<span class="destlabel">' + esc(d.label) + "</span>", iconSize: null, iconAnchor: [14, 10] }), zIndexOffset: 1000 })
      .bindPopup("<b>" + esc(d.label) + "</b><br>" + esc(d.note) + "<br>目的地バス停（" + d.radiusM + "m 以内）: " + esc(d.stops.join("・")))
      .addTo(map);
  });
  DATA.itoshimaStations.forEach(function (st) {
    L.marker([st.lat, st.lng], { icon: L.divIcon({ className: "", html: '<span class="stlabel">□ ' + esc(st.name) + "</span>", iconSize: null, iconAnchor: [10, 8] }) })
      .bindPopup("JR筑肥線 " + esc(st.name) + "駅（ここから " + DATA.itoshimaRadiusM + "m 以内のバス停だけ表示）")
      .addTo(map);
  });

  function apply() {
    var mask = 0;
    for (var i = 0; i < NDEST; i++) { var cb = document.getElementById("cb-" + i); if (cb && cb.checked) mask |= 1 << i; }
    var hit = 0;
    DATA.stops.forEach(function (s, k) {
      var on = mask === 0 || (s.f & mask) === mask;
      if (on) hit++;
      markers[k].setStyle(on
        ? { radius: mask === 0 ? 5 : 6, fillOpacity: 0.95, opacity: 1 }
        : { radius: 3.5, fillOpacity: 0.3, opacity: 0.3 });
      if (on) markers[k].bringToFront();
    });
    var names = DATA.destinations.filter(function (d, i) { return (mask >> i) & 1; }).map(function (d) { return d.label; });
    document.getElementById("count").textContent = mask === 0
      ? "全 " + DATA.stops.length + " 停留所"
      : names.join("・") + " すべてに直通: " + hit + " / " + DATA.stops.length + " 停留所";
  }
  for (var i = 0; i < NDEST; i++) {
    var cb = document.getElementById("cb-" + i);
    if (cb) cb.addEventListener("change", apply);
  }
  apply();
})();
</script>
</body>
</html>
`;

// /listings/bus（非公開・Cloudflare Access 保護）。「バス直通マップ」。
// 職場（祇園町）・学校（東光二丁目など）へ乗り換えなしで着くバスの路線を線で、その停留所を丸で描く。
// データは src/data/bus-routes.json（scripts/collect-nnr-routes.ts が西鉄の時刻表から集める・このファイルからは書き換えない）。
// 元の JSON は 1MB を超えるので、地図に要る項目だけを小数5桁に丸めて HTML に埋め込む（静的に保存してもそのまま開ける）。
// routes[].destStop・stops[].higashiStops は後から足される項目なので、無くても動くように書く。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

import busRoutes from "./data/bus-routes.json";

type DestKey = "gion" | "higashi";

/** src/data/bus-routes.json のうち、この画面が読む項目 */
export interface BusRoutesData {
  meta: {
    generatedAt?: string;
    failures?: { dest: string; terminus: string; reason: string }[];
  };
  routes: {
    dest: string;
    number: string;
    kind: string;
    terminus: string;
    queriedTerminus?: string;
    direction: string;
    morning?: { departures7to9: number; capped: boolean; from: string };
    stops: { name: string; lat: number | null; lng: number | null; passThrough?: boolean }[];
    destIndex: number;
    /** 目的側でどのバス停に着くか（後から足される） */
    destStop?: string;
  }[];
  stops: {
    name: string;
    lat: number | null;
    lng: number | null;
    dests: string[];
    numbers: string[];
    /** そのバス停から直通で行ける学校近くのバス停（後から足される） */
    higashiStops?: string[];
  }[];
}

/** HTML に埋め込む形（キーを短くしてある） */
export interface BusMapData {
  /** 取得日 YYYY-MM-DD（日本時間） */
  date: string;
  failures: { d: DestKey | string; t: string; r: string }[];
  /** 座標が無く丸を描けない停留所 */
  noCoord: string[];
  routes: {
    d: DestKey;
    n: string;
    k: string;
    /** 行先 */
    t: string;
    /** 乗る側の始点（どちら方面から来るか） */
    f: string;
    /** 朝7〜9時の便数（数えていなければ null） */
    m: number | null;
    /** 便数が検索の表示件数いっぱいだった */
    c: boolean;
    /** 目的側で降りるバス停 */
    s?: string;
    p: [number, number][];
  }[];
  stops: { n: string; a: number; o: number; g: 0 | 1; h: 0 | 1; u: string[]; x?: string[] }[];
}

const isDest = (d: string): d is DestKey => d === "gion" || d === "higashi";
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** 取得日時（ISO）→ 日本時間の YYYY-MM-DD */
export function jstDate(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "不明";
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function toBusMapData(raw: BusRoutesData): BusMapData {
  const routes: BusMapData["routes"] = [];
  for (const r of raw.routes) {
    if (r.direction !== "to_dest" || !isDest(r.dest)) continue;
    const p: [number, number][] = [];
    for (const s of r.stops.slice(0, r.destIndex + 1)) {
      if (s.lat == null || s.lng == null) continue;
      const pt: [number, number] = [r5(s.lat), r5(s.lng)];
      const last = p[p.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) continue;
      p.push(pt);
    }
    if (p.length < 2) continue;
    routes.push({
      d: r.dest,
      n: r.number,
      k: r.kind,
      t: r.terminus,
      f: r.morning?.from ?? r.queriedTerminus ?? r.stops[0]?.name ?? "",
      m: r.morning ? r.morning.departures7to9 : null,
      c: r.morning?.capped ?? false,
      ...(r.destStop ? { s: r.destStop } : {}),
      p,
    });
  }
  const stops: BusMapData["stops"] = [];
  const noCoord: string[] = [];
  for (const s of raw.stops) {
    const g = s.dests.includes("gion") ? 1 : 0;
    const h = s.dests.includes("higashi") ? 1 : 0;
    if (!g && !h) continue;
    if (s.lat == null || s.lng == null) {
      noCoord.push(s.name);
      continue;
    }
    stops.push({
      n: s.name,
      a: r5(s.lat),
      o: r5(s.lng),
      g,
      h,
      u: s.numbers,
      ...(s.higashiStops && s.higashiStops.length ? { x: s.higashiStops } : {}),
    });
  }
  return {
    date: jstDate(raw.meta.generatedAt),
    failures: (raw.meta.failures ?? []).map((f) => ({ d: f.dest, t: f.terminus, r: f.reason })),
    noCoord,
    routes,
    stops,
  };
}

export const LEAFLET_VERSION = "1.9.4";
const LEAFLET = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}`;
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 職場・学校の位置（祇園NKビル・東福岡高校） */
export const PLACES = {
  work: { label: "職場（祇園NKビル）", lat: 33.59468, lng: 130.41301 },
  school: { label: "学校（東福岡）", lat: 33.594261, lng: 130.429932, radiusM: 500 },
};

let cached: string | null = null;

export function renderBusRoutesDashboard(raw?: BusRoutesData): string {
  if (raw) return renderHtml(toBusMapData(raw));
  cached ??= renderHtml(toBusMapData(busRoutes as unknown as BusRoutesData));
  return cached;
}

export function renderHtml(data: BusMapData): string {
  const DATA_JSON = safeJson({ ...data, places: PLACES });
  const date = escHtml(data.date);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>バス直通マップ（非公開）</title>
<link rel="stylesheet" href="${LEAFLET}/leaflet.min.css">
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309;
          --gion:#2563eb; --higashi:#ea580c; --both:#7c3aed; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b;
          --gion:#3b82f6; --higashi:#f97316; --both:#a78bfa; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 1100px; margin: 0 auto; padding: 10px 14px; }
  h1 { font-size: 1.2rem; margin: 6px 0 2px; }
  a { color: var(--accent); }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 4px 10px; margin: 6px 0 0; border-radius: 4px; font-size: .82rem; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 8px 0 6px; }
  .checks { display: inline-flex; align-items: center; gap: 4px; font-size: .9rem; }
  .checks input { width: 18px; height: 18px; }
  .count { font-size: .82rem; color: var(--muted); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .8rem; color: var(--muted); }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.25); }
  .sw { display: inline-block; width: 18px; height: 4px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  #map { height: calc(100vh - 250px); min-height: 380px; border: 1px solid var(--line); border-radius: 10px; }
  @media (max-width: 600px) { #map { height: 66vh; } main { padding: 4px 6px; } }
  @media (prefers-color-scheme: dark) { #map .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(.85) contrast(.9); } }
  details { margin: 8px 0 0; font-size: .85rem; }
  details summary { cursor: pointer; color: var(--muted); }
  details ul { margin: 4px 0; padding-left: 1.3em; }
  .leaflet-popup-content { font-size: .85rem; line-height: 1.5; margin: 10px 12px; }
  .leaflet-popup-content b.name { font-size: .95rem; }
  .pop-note { color: #667085; font-size: .78rem; }
  .pop-no { color: #9aa3af; }
  .placedot { position: absolute; left: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.45); }
  .placelabel { position: absolute; left: 0; top: 0; color: #fff; font-size: 11px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
</style>
<script src="${LEAFLET}/leaflet.min.js"></script>
</head>
<body>
<header>
  <h1>バス直通マップ（非公開）</h1>
  <div class="sub"><a href="/listings">← 掲載ウォッチ全体</a> ・<a href="/listings/picks">条件に合う物件 →</a> ／ 職場（祇園）・学校（東福岡）へ乗り換えなしで着くバスの路線と停留所</div>
  <div class="notice">西鉄の時刻表（${date} 取得）から、乗り換えなしで着く便を集めたもの。行先が博多駅などで取れなかった便は入っていない（一覧は下）。</div>
  <div class="bar" id="checks">
    <label class="checks"><input type="checkbox" id="cb-gion" checked><span class="sw" style="background:var(--gion)"></span>職場行き</label>
    <label class="checks"><input type="checkbox" id="cb-higashi" checked><span class="sw" style="background:var(--higashi)"></span>学校行き</label>
    <span class="count" id="count"></span>
  </div>
  <div class="legend" id="legend">
    <span>停留所:</span>
    <span><i style="background:var(--gion)"></i>職場へ直通</span>
    <span><i style="background:var(--higashi)"></i>学校へ直通</span>
    <span><i style="background:var(--both)"></i>両方へ直通</span>
    <span>線を押すと系統と朝の便数</span>
  </div>
</header>
<main>
  <div id="map"></div>
  <details id="failures">
    <summary>入っていない便（${data.failures.length} 件）${data.noCoord.length ? "・座標が無く描けない停留所（" + data.noCoord.length + " 件）" : ""}</summary>
    <ul>
${data.failures.map((f) => `      <li>${f.d === "gion" ? "職場行き" : f.d === "higashi" ? "学校行き" : escHtml(f.d)}・${escHtml(f.t)}: ${escHtml(f.r)}</li>`).join("\n")}
${data.noCoord.map((n) => `      <li>座標なし: ${escHtml(n)}</li>`).join("\n")}
    </ul>
  </details>
</main>
<footer class="sub">出典: バスの路線・停留所: 西日本鉄道 にしてつ時刻表（私的利用）。一部の停留所の位置は 国土数値情報（バス停留所データ）国土交通省 2022年度 を加工。地図: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors。</footer>
<script>
var DATA = ${DATA_JSON};
(function () {
  var css = getComputedStyle(document.documentElement);
  function cssVar(name, fallback) { return css.getPropertyValue(name).trim() || fallback; }
  var COLOR = { gion: cssVar("--gion", "#2563eb"), higashi: cssVar("--higashi", "#ea580c"), both: cssVar("--both", "#7c3aed") };
  var LABEL = { gion: "職場", higashi: "学校" };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  var map = L.map("map", { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  // 線と丸は 1 枚の canvas に描く（pane を分けると上の canvas が下の線のクリックを奪う）。
  // canvas は足した順に重なるので、apply() で毎回「線 → 丸」の順に足し直す。tolerance は指で線を押しやすくするため
  var renderer = L.canvas({ tolerance: 6 });
  var lineLayers = { gion: L.layerGroup(), higashi: L.layerGroup() };
  var stopLayers = { gion: L.layerGroup(), higashi: L.layerGroup() };
  var bothLayer = L.layerGroup();

  function routePopup(r) {
    var h = "<b>" + esc(r.k + " " + r.n) + "</b>（" + esc(r.f) + " 方面から・" + esc(r.t) + " 行き）";
    h += "<br>" + LABEL[r.d] + "へ直通" + (r.s ? "（" + esc(r.s) + " で降りる）" : "");
    if (r.m === null) h += '<br><span class="pop-note">朝の便数は数えていない</span>';
    else h += "<br>朝7〜9時の便 " + r.m + "本以上" + '<br><span class="pop-note">' +
      (r.c ? "検索の表示件数いっぱいで打ち切り。実際はもっと多いかも" : esc(r.f) + " 発で数えた下限") + "</span>";
    return h;
  }
  DATA.routes.forEach(function (r) {
    var line = L.polyline(r.p, { color: COLOR[r.d], weight: 3, opacity: 0.55, renderer: renderer });
    line.bindPopup(function () { return routePopup(r); });
    line.addTo(lineLayers[r.d]);
  });

  function stopPopup(s) {
    var h = '<b class="name">' + esc(s.n) + "</b>";
    h += "<br>" + (s.g ? "○ 職場へ直通" : '<span class="pop-no">× 職場へ直通なし</span>');
    h += "<br>" + (s.h ? "○ 学校へ直通" + (s.x && s.x.length ? "（学校近くの " + s.x.map(esc).join("・") + " で降りる）" : "")
                       : '<span class="pop-no">× 学校へ直通なし</span>');
    h += '<br><span class="pop-note">系統: ' + s.u.map(esc).join("・") + "</span>";
    return h;
  }
  DATA.stops.forEach(function (s) {
    var col = s.g && s.h ? COLOR.both : (s.g ? COLOR.gion : COLOR.higashi);
    var m = L.circleMarker([s.a, s.o], { radius: 4, weight: 1, color: "#00000066", fillColor: col, fillOpacity: 0.9, renderer: renderer });
    m.bindPopup(function () { return stopPopup(s); });
    (s.g && s.h ? bothLayer : (s.g ? stopLayers.gion : stopLayers.higashi)).addLayer(m);
  });

  // 職場と学校は 1.6km しか離れていないので、職場の札は点の左・学校の札は点の右に出す
  function placeIcon(label, color, side) {
    var shift = side === "left" ? "translate(calc(-100% - 2px), -50%)" : "translate(2px, -50%)";
    return L.divIcon({ className: "", iconSize: [0, 0], iconAnchor: [0, 0],
      html: '<span class="placedot" style="background:' + color + '"></span><span class="placelabel" style="background:' + color + ";transform:" + shift + '">' + esc(label) + "</span>" });
  }
  var P = DATA.places;
  L.circle([P.school.lat, P.school.lng], { radius: P.school.radiusM, color: COLOR.higashi, weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
  L.marker([P.work.lat, P.work.lng], { icon: placeIcon(P.work.label, COLOR.gion, "left"), zIndexOffset: 1000 }).bindPopup(esc(P.work.label)).addTo(map);
  L.marker([P.school.lat, P.school.lng], { icon: placeIcon(P.school.label, COLOR.higashi, "right"), zIndexOffset: 1000 })
    .bindPopup(esc(P.school.label) + "<br>破線の円は半径 " + P.school.radiusM + "m").addTo(map);

  // 甘木・糸島などへ伸びる長い線まで入れると引きすぎるので、市街地に合わせる（線は地図を動かせば見える）
  map.fitBounds([[33.52, 130.30], [33.67, 130.47]]);

  function count(arr, f) { var n = 0; arr.forEach(function (x) { if (f(x)) n++; }); return n; }
  function apply() {
    var on = { gion: document.getElementById("cb-gion").checked, higashi: document.getElementById("cb-higashi").checked };
    var all = [lineLayers.gion, lineLayers.higashi, stopLayers.gion, stopLayers.higashi, bothLayer];
    all.forEach(function (g) { map.removeLayer(g); });
    ["gion", "higashi"].forEach(function (k) { if (on[k]) lineLayers[k].addTo(map); });
    ["gion", "higashi"].forEach(function (k) { if (on[k]) stopLayers[k].addTo(map); });
    if (on.gion || on.higashi) bothLayer.addTo(map);
    var nl = count(DATA.routes, function (r) { return on[r.d]; });
    var ns = count(DATA.stops, function (s) { return (on.gion && s.g) || (on.higashi && s.h); });
    document.getElementById("count").textContent = "線 " + nl + " 本・停留所 " + ns + "（両方へ直通 " + count(DATA.stops, function (s) { return s.g && s.h; }) + "）";
  }
  document.getElementById("cb-gion").addEventListener("change", apply);
  document.getElementById("cb-higashi").addEventListener("change", apply);
  apply();
})();
</script>
</body>
</html>
`;
}

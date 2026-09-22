// /listings/shinchiku（非公開・Cloudflare Access 保護）。新築マンションのビュー。データは /api/listings/shinchiku（src/new-listings.ts）。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

import { DEFAULT_NEW_FILTERS } from "./new-listing-view";
import { AREAS, GROUP_LABEL } from "./wards";

export function renderNewListingsDashboard(): string {
  return HTML;
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const AREAS_JSON = safeJson(AREAS);
const GROUPS_JSON = safeJson(GROUP_LABEL);
const D = DEFAULT_NEW_FILTERS;

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>新築マンション（非公開）</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309; --bad:#b91c1c; --good:#0f766e; --chip:#eef2ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b; --bad:#f87171; --good:#5eead4; --chip:#26304a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 760px; margin: 0 auto; padding: 12px 16px; }
  h1 { font-size: 1.2rem; margin: 8px 0 4px; }
  a { color: var(--accent); }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 6px 10px; margin: 6px 0; border-radius: 4px; font-size: .85rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; }
  form { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px 10px; align-items: end; }
  label { display: flex; flex-direction: column; font-size: .78rem; color: var(--muted); gap: 2px; }
  select, input, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); min-width: 0; }
  input[type="number"] { width: 100%; }
  .checks { display: flex; flex-direction: row; align-items: center; gap: 4px; font-size: .82rem; color: var(--ink); }
  .full { grid-column: 1 / -1; }
  button { background: var(--accent); color: #fff; border: none; font-weight: 600; cursor: pointer; }
  select[multiple] { min-height: 7.5em; }
  details.adv summary { cursor: pointer; font-size: .85rem; color: var(--accent); margin-bottom: 6px; }
  .toggles { display: flex; flex-wrap: wrap; gap: 10px 14px; grid-column: 1 / -1; }
  .count { color: var(--muted); font-size: .85rem; margin: 4px 0 10px; }
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--bg); overflow-wrap: anywhere; }
  .card h3 { margin: 0 0 4px; font-size: 1rem; }
  .badge { display: inline-block; background: var(--chip); color: var(--ink); border-radius: 999px; padding: 1px 8px; font-size: .75rem; margin-left: 6px; font-weight: 400; }
  .ended { color: var(--bad); }
  .price { font-size: 1.15rem; font-weight: 700; margin: 4px 0; }
  .price .unit { font-size: .8rem; font-weight: 400; color: var(--muted); margin-left: 6px; }
  .meta { font-size: .85rem; color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 3px 0; font-size: .85rem; }
  .prem { font-size: .85rem; margin: 6px 0; }
  .prem b { font-size: 1rem; }
  .up { color: var(--bad); }
  .down { color: var(--good); }
  .empty { color: var(--muted); padding: 20px 0; text-align: center; }
  .crawl { font-size: .8rem; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>新築マンション（非公開）</h1>
  <div class="sub"><a href="/listings">← 掲載ウォッチ全体</a> ／ <a href="/listings/picks">条件に合う中古</a> ／ 私的・非商用の個人利用</div>
  <div class="sub" id="asof">読み込み中…</div>
  <div class="crawl" id="crawl"></div>
  <div id="notices"></div>
</header>
<main>
  <section>
    <form id="filters">
      <div class="sub full">既定の条件: 価格の下限が ${D.priceMaxMan.toLocaleString("ja-JP")}万円以下・面積の上限が ${D.areaMin}㎡以上（新築は幅があるので「その物件の中に条件に合う住戸がありうる」もの）。価格未定の物件は既定で含めます。</div>
      <label>価格 下限の上限(万円)<input type="number" name="pmax" min="0" step="100" placeholder="${D.priceMaxMan}"></label>
      <label>面積 上限の下限(㎡)<input type="number" name="amin" min="0" step="1" placeholder="${D.areaMin}"></label>
      <label>種別<select name="type"><option value="all">物件・住戸の両方</option><option value="project">物件（分譲）だけ</option><option value="unit">住戸の掲載だけ</option></select></label>
      <label>並べ替え<select name="sort"><option value="newest">初回掲載の新しい順</option><option value="premium">新築プレミアムの低い順</option><option value="price">価格の安い順</option><option value="delivery">引渡の早い順</option></select></label>
      <div class="toggles">
        <label class="checks"><input type="checkbox" name="all" value="1"> 全件表示（価格・面積の条件をかけない）</label>
        <label class="checks"><input type="checkbox" name="noundecided" value="1"> 価格未定を除く</label>
        <label class="checks"><input type="checkbox" name="ended" value="1"> 掲載終了も含める</label>
      </div>
      <details class="adv full">
        <summary>市区町村を絞る（既定はすべて）</summary>
        <label class="full">市区町村<select name="muni" multiple id="muni-select"></select></label>
      </details>
      <button type="submit" class="full">この条件で表示</button>
    </form>
  </section>
  <div class="count" id="count">読み込み中…</div>
  <section>
    <div class="cards" id="cards"></div>
  </section>
</main>
<footer class="sub">
  データの出典: SUUMO（株式会社リクルート）の新築マンション掲載（私的利用・週1回）。新築プレミアムの分母は国交省 不動産情報ライブラリの成約価格（築10年以内の中古）。
</footer>
<script>
(function () {
  var AREAS = ${AREAS_JSON};
  var GROUP_LABEL = ${GROUPS_JSON};
  var LS_KEY = "fcw_shinchiku_filters_v1";
  function esc(v) { return String(v === null || v === undefined ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function n(v, d) { if (v === null || v === undefined) return "—"; return Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d || 0 }); }
  function range(a, b, unit, d) {
    if (a === null || a === undefined) return "—";
    if (b === null || b === undefined || a === b) return n(a, d) + unit;
    return n(a, d) + "〜" + n(b, d) + unit;
  }

  var sel = document.getElementById("muni-select");
  var byGroup = {};
  AREAS.forEach(function (a) { (byGroup[a.group] = byGroup[a.group] || []).push(a); });
  Object.keys(byGroup).forEach(function (g) {
    var og = document.createElement("optgroup");
    og.label = GROUP_LABEL[g] || g;
    byGroup[g].forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.code; opt.textContent = a.name;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });

  var f = document.getElementById("filters");
  function saveCurrent() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        pmax: f.pmax.value, amin: f.amin.value, type: f.type.value, sort: f.sort.value,
        all: f.all.checked, noundecided: f.noundecided.checked, ended: f.ended.checked,
        muni: Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; }),
      }));
    } catch (e) { /* 無視 */ }
  }
  (function applySaved() {
    var s = null;
    try { var raw = localStorage.getItem(LS_KEY); s = raw ? JSON.parse(raw) : null; } catch (e) { s = null; }
    if (!s) return;
    if (s.pmax) f.pmax.value = s.pmax;
    if (s.amin) f.amin.value = s.amin;
    if (["all", "project", "unit"].indexOf(s.type) !== -1) f.type.value = s.type;
    if (["newest", "premium", "price", "delivery"].indexOf(s.sort) !== -1) f.sort.value = s.sort;
    f.all.checked = !!s.all; f.noundecided.checked = !!s.noundecided; f.ended.checked = !!s.ended;
    if (s.muni && s.muni.length) Array.prototype.forEach.call(sel.options, function (o) { o.selected = s.muni.indexOf(o.value) !== -1; });
  })();

  function buildParams() {
    var p = new URLSearchParams();
    if (f.pmax.value) p.set("pmax", f.pmax.value);
    if (f.amin.value) p.set("amin", f.amin.value);
    if (f.type.value !== "all") p.set("type", f.type.value);
    if (f.sort.value !== "newest") p.set("sort", f.sort.value);
    if (f.all.checked) p.set("all", "1");
    if (f.noundecided.checked) p.set("undecided", "0");
    if (f.ended.checked) p.set("ended", "1");
    var munis = Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; });
    if (munis.length) p.set("muni", munis.join(","));
    return p;
  }

  function premiumLine(p) {
    if (!p) return '<div class="prem meta">新築プレミアム —（価格未定、または比べる中古の成約が足りない）</div>';
    var pct = Math.round(p.value * 1000) / 10;
    var cls = pct >= 0 ? "up" : "down";
    var where = p.level === "district" ? ("地区「" + esc(p.areaName) + "」") : (esc(p.areaName) + "全体（地区は件数不足）");
    return '<div class="prem">新築プレミアム <b class="' + cls + '">' + (pct >= 0 ? "+" : "") + pct.toFixed(1) + '%</b>' +
      '<span class="meta">（新築 ' + n(p.newUnit / 10000, 1) + '万円/㎡ ÷ ' + where + 'の築10年以内中古 ' + n(p.usedUnitMedian / 10000, 1) + '万円/㎡・' + n(p.n) + '件）</span></div>';
  }

  function priceText(it) {
    if (it.priceMin === null) return "価格未定";
    var s = range(it.priceMin, it.priceMax, "万円");
    if (it.priceTentative) s += "（予定を含む）";
    if (it.priceUndecided) s += "＋未定の期あり";
    return s;
  }

  function changeText(it) {
    var h = it.priceHistory || [];
    var priced = h.filter(function (x) { return x.minMan !== null; });
    if (it.priceChangeCount === 0 || h.length < 2) return "価格変化なし";
    var first = priced.length ? priced[0] : null;
    var fromTxt = first ? range(first.minMan, first.maxMan, "万") + "（" + esc(first.on) + "）" : "未定";
    return '価格変化 ' + it.priceChangeCount + '回: ' + fromTxt + ' → ' + (it.priceMin === null ? "未定" : range(it.priceMin, it.priceMax, "万"));
  }

  function card(it) {
    var station = it.bus ? (esc(it.lineName || "") + " " + esc(it.stationName || "") + "（バス便）")
      : (it.stationName ? esc(it.lineName || "") + "「" + esc(it.stationName) + "」徒歩" + n(it.walkMinutes) + "分" : "—");
    var unit = it.unitPriceMin === null ? "—" : range(it.unitPriceMin / 10000, it.unitPriceMax === null ? null : it.unitPriceMax / 10000, "万円/㎡", 1);
    return '' +
      '<div class="card">' +
      '<h3>' + esc(it.buildingName || "（名称なし）") +
      '<span class="badge">' + (it.type === "unit" ? "住戸の掲載" : "物件") + '</span>' +
      (it.saleStatusLabel ? '<span class="badge">' + esc(it.saleStatusLabel) + '</span>' : '') +
      (it.delistedOn ? '<span class="badge ended">掲載終了 ' + esc(it.delistedOn) + '</span>' : '') + '</h3>' +
      '<div class="meta">' + esc(it.address || "") + '</div>' +
      '<div class="row">' + station + '</div>' +
      '<div class="price">' + priceText(it) + '<span class="unit">㎡単価 ' + unit + '</span></div>' +
      '<div class="row">' + esc(it.floorPlans || "—") + ' ・ ' + range(it.areaMin, it.areaMax, "㎡", 2) + '</div>' +
      '<div class="row">引渡 ' + esc(it.deliveryText || "—") + (it.saleLabel ? ' ・ 販売 ' + esc(it.saleLabel) : '') + '</div>' +
      '<div class="row">初回掲載 ' + esc(it.firstSeen) + ' ・ ' + changeText(it) + '</div>' +
      premiumLine(it.premium) +
      (it.url ? '<div class="row"><a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">SUUMO で見る</a></div>' : '') +
      '</div>';
  }

  function load() {
    var params = buildParams();
    saveCurrent();
    fetch("/api/listings/shinchiku?" + params.toString(), { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      document.getElementById("asof").textContent = d.today + " 時点。掲載中 " + d.active + " 件（記録 " + d.total + " 件）";
      var runs = (d.crawl && d.crawl.runs) || [];
      var last = runs[0];
      document.getElementById("crawl").textContent = last
        ? "直近のクロール: " + last.crawl_date + " " + last.status + "（" + last.pages_fetched + " ページ・見えた " + last.listings_seen + " 件・新着 " + last.new_count + "・価格変化 " + last.price_change_count + "・掲載終了 " + last.gone_count + "）"
        : "新築のクロールはまだ一度も走っていません（毎週日曜 06:00・Mac の launchd）";
      document.getElementById("notices").innerHTML = (d.notes || []).map(function (t) { return '<div class="notice">' + esc(t) + "</div>"; }).join("");
      var pb = d.premiumBasis;
      document.getElementById("count").textContent = d.matched + " 件" + (d.filters.all ? "（全件表示）" : "") +
        (pb && pb.to ? "。プレミアムの分母は" + pb.label + " " + pb.from + "〜" + pb.to + "（築" + pb.maxAgeYears + "年以内）" : "。プレミアムの分母（成約価格）がまだありません");
      document.getElementById("cards").innerHTML = d.items.length ? d.items.map(card).join("") : '<div class="empty">条件に合う新築はありませんでした</div>';
    }).catch(function (e) {
      document.getElementById("notices").innerHTML = '<div class="notice">読み込み失敗: ' + esc(e.message) + "</div>";
      document.getElementById("cards").innerHTML = "";
      document.getElementById("count").textContent = "";
    });
  }
  f.addEventListener("submit", function (ev) { ev.preventDefault(); load(); });
  load();
})();
</script>
</body>
</html>`;

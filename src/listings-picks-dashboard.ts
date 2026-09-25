// /listings/picks（非公開・Cloudflare Access 保護）。「条件に合う新着・掲載中の物件」ビュー。
// 売買（中古・既定）と賃貸（?kind=rent。2026-09-26〜）をタブで切り替える。データは /api/listings/picks（src/listing-picks.ts）。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

import { DEFAULT_PICK_FILTERS, DEFAULT_RENT_PICK_FILTERS } from "./listing-grouping";
import { AREAS, GROUP_LABEL } from "./wards";

export function renderListingsPicksDashboard(): string {
  return HTML;
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const AREAS_JSON = safeJson(AREAS);
const GROUPS_JSON = safeJson(GROUP_LABEL);
const D = DEFAULT_PICK_FILTERS;
const R = DEFAULT_RENT_PICK_FILTERS;
const DEFAULTS_SALE_JSON = safeJson(D);
const DEFAULTS_RENT_JSON = safeJson(R);
const SALE_DEFAULTS_TEXT =
  `既定の条件: ${D.priceMaxMan.toLocaleString("ja-JP")}万円以下・${D.areaMin}㎡以上・${D.planRoomsMin}LDK以上・` +
  `築${D.ageMax}年以内・駅徒歩${D.walkMax}分以内（バス便は除く）。空欄の項目は既定の値で絞ります。`;
const RENT_DEFAULTS_TEXT =
  `既定の条件: 家賃 ${R.priceMaxMan}万円以下・${R.areaMin}㎡以上・${R.planRoomsMin}LDK以上・築${R.ageMax}年以内` +
  `（徒歩分は指定なし・バス便も含む）。空欄の項目は既定の値で絞ります。`;

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>条件に合う物件（非公開）</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309; --bad:#b91c1c; --good:#0f766e; --chip:#eef2ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b; --bad:#f87171; --good:#5eead4; --chip:#26304a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 760px; margin: 0 auto; padding: 12px 14px; }
  h1 { font-size: 1.2rem; margin: 8px 0 4px; }
  h2 { font-size: 1rem; margin: 0 0 6px; }
  a { color: var(--accent); }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 6px 10px; margin: 6px 0; border-radius: 4px; font-size: .85rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; }
  form { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px 10px; align-items: end; }
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
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--bg); }
  .card h3 { margin: 0 0 4px; font-size: 1rem; }
  .badge { display: inline-block; background: var(--chip); color: var(--ink); border-radius: 999px; padding: 1px 8px; font-size: .75rem; margin-left: 6px; }
  .price { font-size: 1.15rem; font-weight: 700; margin: 4px 0; }
  .price .unit { font-size: .8rem; font-weight: 400; color: var(--muted); margin-left: 6px; }
  .meta { font-size: .85rem; color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 3px 0; font-size: .85rem; }
  .scoreline { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 6px 0; font-size: .8rem; }
  .scoreline b { color: var(--ink); }
  .fresh { color: var(--good); font-weight: 600; }
  .cut { color: var(--bad); }
  .urls { margin: 6px 0 0; padding: 0; list-style: none; font-size: .82rem; display: flex; flex-direction: column; gap: 2px; }
  .empty { color: var(--muted); padding: 20px 0; text-align: center; }
  .coverage { font-size: .8rem; color: var(--muted); }
  .coverage .miss { color: var(--warn); }
  nav.tabs { display: flex; gap: 8px; margin: 8px 0 2px; }
  nav.tabs a { display: inline-block; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; font-size: .85rem; color: var(--muted); background: var(--card); }
  nav.tabs a.on { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
  .badge.pets { background: color-mix(in srgb, var(--good) 20%, transparent); }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1 id="title">条件に合う新着・掲載中の物件（非公開）</h1>
  <div class="sub"><a href="/listings">← 掲載ウォッチ全体</a> ／ 私的・非商用の個人利用</div>
  <nav class="tabs"><a id="tab-sale" href="/listings/picks">売買（中古）</a><a id="tab-rent" href="/listings/picks?kind=rent">賃貸</a></nav>
  <div class="sub" id="asof">読み込み中…</div>
  <div id="notices"></div>
  <div class="coverage" id="coverage"></div>
</header>
<main>
  <section>
    <form id="filters">
      <div class="sub full" id="defaults-text">${SALE_DEFAULTS_TEXT}</div>
      <label id="lb-pmax">価格 上限(万円)<input type="number" name="pmax" min="0" step="100" placeholder="${D.priceMaxMan}"></label>
      <label>面積 下限(㎡)<input type="number" name="amin" min="0" step="1" placeholder="${D.areaMin}"></label>
      <label>間取り 部屋数下限<input type="number" name="plan" min="1" step="1" placeholder="${D.planRoomsMin}"></label>
      <label>築年数 上限(年)<input type="number" name="age" min="0" step="1" placeholder="${D.ageMax}"></label>
      <label>徒歩 上限(分)<input type="number" name="walk" min="0" step="1" placeholder="${D.walkMax}"></label>
      <label id="lb-sort">並べ替え<select name="sort"><option value="newest">新着順</option><option value="retention" id="opt-retention">価格維持の高い順</option></select></label>
      <div class="toggles">
        <label class="checks"><input type="checkbox" name="dk" value="1"> DK・Kタイプも含める</label>
        <label class="checks"><input type="checkbox" name="bus" value="1"> バス便も含める</label>
        <label class="checks" id="lb-pets"><input type="checkbox" name="pets" value="1"> ペット相談可のみ</label>
        <label class="checks"><input type="checkbox" name="fresh" value="1"> 新着のみ（${D.freshDays}日以内）</label>
      </div>
      <details class="adv full">
        <summary>市区町村を絞る（既定はすべて）</summary>
        <label class="full">市区町村<select name="muni" multiple id="muni-select"></select></label>
      </details>
      <button type="submit" class="full">この条件で表示</button>
    </form>
  </section>
  <div class="count" id="count">読み込み中…</div>
  <section id="cards-section">
    <div class="cards" id="cards"></div>
  </section>
</main>
<footer class="sub" id="footer">
  データの出典: SUUMO（株式会社リクルート）の掲載情報（私的利用）。売りやすさ・貸しやすさ・売出/成約比は国交省 不動産情報ライブラリ・e-Stat 等をもとにした市区町村単位の目安（<a href="/listings">掲載ウォッチ</a>参照）。価格維持は同じ不動産情報ライブラリの成約価格から、地区（町名）または市区町村単位で出した目安。
</footer>
<script>
(function () {
  var AREAS = ${AREAS_JSON};
  var GROUP_LABEL = ${GROUPS_JSON};
  var DEFAULTS = { sale: ${DEFAULTS_SALE_JSON}, rent: ${DEFAULTS_RENT_JSON} };
  var DEFAULTS_TEXT = { sale: ${safeJson(SALE_DEFAULTS_TEXT)}, rent: ${safeJson(RENT_DEFAULTS_TEXT)} };
  var KIND = new URLSearchParams(location.search).get("kind") === "rent" ? "rent" : "sale";
  var IS_RENT = KIND === "rent";
  var D = DEFAULTS[KIND];
  var LS_KEY = "fcw_picks_filters_v1_" + KIND;
  function esc(v) { return String(v === null || v === undefined ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function n(v, d) { if (v === null || v === undefined) return "—"; return Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d || 0 }); }
  function man(yen) { return yen === null || yen === undefined ? "—" : n(Math.round(yen / 10000)); }

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

  // ---- 種類（売買・賃貸）に合わせて見出し・タブ・入力欄の既定を差し替える
  (function setupKind() {
    document.getElementById("tab-" + KIND).className = "on";
    document.getElementById("title").textContent = IS_RENT
      ? "条件に合う賃貸（掲載中・非公開）"
      : "条件に合う新着・掲載中の物件（非公開）";
    document.title = IS_RENT ? "条件に合う賃貸（非公開）" : "条件に合う物件（非公開）";
    document.getElementById("defaults-text").textContent = DEFAULTS_TEXT[KIND];
    var f = document.getElementById("filters");
    var ph = function (name, v) { f[name].placeholder = v === null || v === undefined ? "指定なし" : String(v); };
    ph("pmax", D.priceMaxMan); ph("amin", D.areaMin); ph("plan", D.planRoomsMin); ph("age", D.ageMax); ph("walk", D.walkMax);
    if (IS_RENT) {
      f.pmax.step = "1";
      document.getElementById("lb-pmax").firstChild.nodeValue = "家賃 上限(万円/月)";
      // 価格維持は売買の指標なので賃貸では出さない
      document.getElementById("opt-retention").remove();
      f.bus.checked = true;
      document.getElementById("footer").innerHTML =
        'データの出典: SUUMO（株式会社リクルート）の賃貸掲載（私的利用）。貸しやすさは国交省 不動産情報ライブラリ・e-Stat 等をもとにした市区町村単位の目安（<a href="/listings">掲載ウォッチ</a>参照）。' +
        '売買の指標（売りやすさ・売出/成約比・価格維持）は賃貸では出していません。';
    } else {
      document.getElementById("lb-pets").className = "checks hidden";
    }
  })();

  function loadSaved() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveCurrent() {
    try {
      var f = document.getElementById("filters");
      var data = {
        pmax: f.pmax.value, amin: f.amin.value, plan: f.plan.value, age: f.age.value, walk: f.walk.value,
        dk: f.dk.checked, bus: f.bus.checked, pets: f.pets.checked, fresh: f.fresh.checked, sort: f.sort.value,
        muni: Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; }),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) { /* 無視（プライベートブラウズ等） */ }
  }
  function applySaved(saved) {
    if (!saved) return;
    var f = document.getElementById("filters");
    if (saved.pmax) f.pmax.value = saved.pmax;
    if (saved.amin) f.amin.value = saved.amin;
    if (saved.plan) f.plan.value = saved.plan;
    if (saved.age) f.age.value = saved.age;
    if (saved.walk) f.walk.value = saved.walk;
    f.dk.checked = !!saved.dk;
    f.bus.checked = !!saved.bus;
    f.pets.checked = !!saved.pets;
    f.fresh.checked = !!saved.fresh;
    if (saved.sort === "newest" || (saved.sort === "retention" && !IS_RENT)) f.sort.value = saved.sort;
    if (saved.muni && saved.muni.length) {
      Array.prototype.forEach.call(sel.options, function (o) { o.selected = saved.muni.indexOf(o.value) !== -1; });
    }
  }
  applySaved(loadSaved());

  function buildParams() {
    var f = document.getElementById("filters");
    var p = new URLSearchParams();
    if (f.pmax.value) p.set("pmax", f.pmax.value);
    if (f.amin.value) p.set("amin", f.amin.value);
    if (f.plan.value) p.set("plan", f.plan.value);
    if (f.age.value) p.set("age", f.age.value);
    if (f.walk.value) p.set("walk", f.walk.value);
    if (IS_RENT) p.set("kind", "rent");
    if (f.dk.checked) p.set("dk", "1");
    // バス便は賃貸の既定が「含める」なので、外したときに 0 を明示する
    if (IS_RENT) { if (!f.bus.checked) p.set("bus", "0"); } else if (f.bus.checked) p.set("bus", "1");
    if (IS_RENT && f.pets.checked) p.set("pets", "1");
    if (f.fresh.checked) p.set("fresh", "1");
    if (f.sort.value === "retention" && !IS_RENT) p.set("sort", "retention");
    var munis = Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; });
    if (munis.length) p.set("muni", munis.join(","));
    return p;
  }

  function scoreLabel(score, statusLabel) {
    if (score !== null && score !== undefined) return score + "点";
    return statusLabel || "—";
  }

  function retentionLabel(r) {
    if (!r) return '<span>価格維持 <b>—</b><span class="meta">（地区・市区町村とも件数不足）</span></span>';
    var where = r.level === "district" ? ("地区「" + esc(r.areaName) + "」") : (esc(r.areaName) + "全体・地区は件数不足");
    return '<span>価格維持 <b>' + Number(r.value).toFixed(2) + '</b><span class="meta">（' + where + '・直近' + n(r.nRecent) + '件/前期' + n(r.nPrior) + '件）</span></span>';
  }

  function yen(v) { return v === null || v === undefined ? "—" : n(v) + "円"; }

  /** 賃貸のカード。賃料＋管理費・敷礼・ペット相談可・掲載日を出す（価格維持・売出/成約は売買の指標なので出さない） */
  function rentCard(it) {
    var addr = [it.wardName, it.districtName].filter(Boolean).join(" ");
    var station = it.stationName
      ? esc(it.lineName || "") + "「" + esc(it.stationName) + "」" + (it.bus ? "バス便" : "徒歩" + n(it.walkMinutes) + "分")
      : (it.bus ? "バス便" : "—");
    var age = it.buildingYear ? (new Date().getFullYear() - it.buildingYear) + "年（" + it.buildingYear + "年）" : "—";
    var rent = it.minPrice === it.maxPrice ? yen(it.minPrice) : (yen(it.minPrice) + "〜" + yen(it.maxPrice));
    var fee = it.adminFeeMin === null || it.adminFeeMin === undefined ? "管理費 不明"
      : (it.adminFeeMin === it.adminFeeMax ? "管理費 " + yen(it.adminFeeMin) : "管理費 " + yen(it.adminFeeMin) + "〜" + yen(it.adminFeeMax));
    var urls = it.urls.map(function (u, i) { return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">SUUMO で見る' + (it.urls.length > 1 ? "（" + (i + 1) + "）" : "") + "</a></li>"; }).join("");
    return '' +
      '<div class="card">' +
      '<h3>' + esc(it.buildingName) + (it.count > 1 ? '<span class="badge">同条件の部屋 ' + it.count + '件</span>' : '') +
      (it.isFresh ? '<span class="badge fresh">新着</span>' : '') +
      (it.petsAllowed ? '<span class="badge pets">ペット相談可</span>' : '') + '</h3>' +
      '<div class="meta">' + esc(addr) + '</div>' +
      '<div class="row">' + station + '</div>' +
      '<div class="row">' + esc(it.floorPlan || "—") + ' ・ ' + n(it.areaSqm, 1) + '㎡ ・ 築' + age + '</div>' +
      '<div class="price">' + rent + '<span class="unit">/月 ・ ' + fee + '</span></div>' +
      '<div class="row">敷金 ' + yen(it.depositMin) + ' ・ 礼金 ' + yen(it.keyMoneyMin) + '</div>' +
      '<div class="row">掲載開始 ' + esc(it.earliestFirstSeen) + (it.listedOn ? ' ・ 情報公開日 ' + esc(it.listedOn) : '') + '</div>' +
      '<div class="scoreline">' +
      '<span>貸しやすさ（市区町村） <b>' + scoreLabel(it.rentScore, it.rentStatusLabel) + '</b></span>' +
      '</div>' +
      '<ul class="urls">' + urls + '</ul>' +
      '</div>';
  }

  function card(it) {
    if (IS_RENT) return rentCard(it);
    var addr = [it.wardName, it.districtName].filter(Boolean).join(" ");
    var station = it.bus ? (esc(it.lineName || "") + " " + esc(it.stationName || "") + " バス便")
      : (it.stationName ? esc(it.lineName || "") + "「" + esc(it.stationName) + "」徒歩" + n(it.walkMinutes) + "分" : "—");
    var age = it.buildingYear ? (new Date().getFullYear() - it.buildingYear) + "年（" + it.buildingYear + "年）" : "—";
    var unit = it.unitPriceMin === it.unitPriceMax ? n(it.unitPriceMin) : (n(it.unitPriceMin) + "〜" + n(it.unitPriceMax));
    var priceLine = it.minPrice === it.maxPrice ? (man(it.minPrice) + "万円") : (man(it.minPrice) + "〜" + man(it.maxPrice) + "万円");
    var urls = it.urls.map(function (u, i) { return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">SUUMO で見る' + (it.urls.length > 1 ? "（業者" + (i + 1) + "）" : "") + "</a></li>"; }).join("");
    return '' +
      '<div class="card">' +
      '<h3>' + esc(it.buildingName) + (it.count > 1 ? '<span class="badge">重複掲載 ' + it.count + '件</span>' : '') + (it.isFresh ? '<span class="badge fresh">新着</span>' : '') + '</h3>' +
      '<div class="meta">' + esc(addr) + '</div>' +
      '<div class="row">' + station + '</div>' +
      '<div class="row">' + esc(it.floorPlan || "—") + ' ・ ' + n(it.areaSqm, 1) + '㎡ ・ 築' + age + '</div>' +
      '<div class="price">' + priceLine + '<span class="unit">㎡単価 ' + unit + '円</span></div>' +
      '<div class="row">値下げ ' + (it.priceCutCountMax > 0 ? '<span class="cut">' + it.priceCutCountMax + '回</span>' : '0回') + ' ・ 掲載開始 ' + esc(it.earliestFirstSeen) + '</div>' +
      '<div class="scoreline">' +
      '<span>売りやすさ <b>' + scoreLabel(it.sellScore, it.sellStatusLabel) + '</b></span>' +
      '<span>貸しやすさ <b>' + scoreLabel(it.rentScore, it.rentStatusLabel) + '</b></span>' +
      '<span>売出/成約 <b>' + (it.askToTx === null ? (it.askToTxStatus === "few_sales" ? "件数不足" : "—") : it.askToTx.toFixed(2)) + '</b></span>' +
      '</div>' +
      '<div class="scoreline">' + retentionLabel(it.retention) + '</div>' +
      '<ul class="urls">' + urls + '</ul>' +
      '</div>';
  }

  function load() {
    var params = buildParams();
    saveCurrent();
    fetch("/api/listings/picks?" + params.toString(), { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      document.getElementById("asof").textContent = "データ取得 " + esc(d.today) + "時点。" +
        (d.coverage && d.coverage.lastCompleteAt ? "最終の完走クロール: " + esc(d.coverage.lastCompleteAt) : "完走したクロールはまだありません") +
        (d.coverage && d.coverage.latestRun ? "（直近の起動: " + esc(d.coverage.latestRun.crawlDate) + " " + esc(d.coverage.latestRun.status) + "）" : "");
      document.getElementById("notices").innerHTML = (d.notes || []).map(function (t) { return '<div class="notice">' + esc(t) + "</div>"; }).join("");
      if (d.coverage && d.coverage.areas && d.coverage.areas.length) {
        var missing = d.coverage.areas.filter(function (a) { return a.status !== "done"; });
        document.getElementById("coverage").innerHTML = missing.length === 0
          ? "直近の起動で 23 市区町村すべて取得済み"
          : '取得できていない市区町村（直近の起動）: <span class="miss">' + missing.map(function (a) { return esc(a.name) + "(" + esc(a.status) + ")"; }).join("・") + "</span>";
      }
      var rb = d.retentionBasis;
      document.getElementById("count").textContent = d.groups + " 件（重複を含む掲載 " + d.matchedListings + " 件をまとめた数）・" +
        (!IS_RENT && d.filters && d.filters.sort === "retention" ? "価格維持の高い順（値の無いものは末尾）" : "新着順") +
        (!IS_RENT && rb && rb.latestQuarter ? "。価格維持は" + rb.label + " " + rb.recentFrom + "〜" + rb.latestQuarter + " ÷ " + rb.priorFrom + "〜" + rb.priorTo : "");
      document.getElementById("cards").innerHTML = d.items.length ? d.items.map(card).join("") : '<div class="empty">条件に合う' + (IS_RENT ? "賃貸" : "物件") + 'はありませんでした</div>';
    }).catch(function (e) {
      document.getElementById("notices").innerHTML = '<div class="notice">読み込み失敗: ' + esc(e.message) + "</div>";
      document.getElementById("cards").innerHTML = "";
      document.getElementById("count").textContent = "";
    });
  }
  document.getElementById("filters").addEventListener("submit", function (ev) { ev.preventDefault(); load(); });
  load();
})();
</script>
</body>
</html>`;

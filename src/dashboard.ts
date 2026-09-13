// ダッシュボード（1 枚の HTML）。データは /api/metrics から取る。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

export function renderDashboard(): string {
  return HTML;
}

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>福岡市 中古マンション ウォッチ</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 1100px; margin: 0 auto; padding: 12px 14px; }
  h1 { font-size: 1.25rem; margin: 8px 0 4px; }
  h2 { font-size: 1.05rem; margin: 0 0 8px; }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 6px 10px; margin: 6px 0; border-radius: 4px; font-size: .9rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; }
  form { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: end; }
  label { display: flex; flex-direction: column; font-size: .8rem; color: var(--muted); gap: 2px; }
  select, input, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); min-width: 0; }
  button { background: var(--accent); color: #fff; border: none; font-weight: 600; }
  .formula { font-size: .82rem; color: var(--muted); background: var(--bg); padding: 6px 8px; border-radius: 6px; margin: 4px 0 8px; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; white-space: nowrap; }
  th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: right; }
  th:first-child, td:first-child, th.l, td.l { text-align: left; }
  th { font-weight: 600; color: var(--muted); position: sticky; top: 0; background: var(--card); }
  .score { font-weight: 700; }
  .chart { position: relative; height: 300px; }
  .empty { color: var(--muted); font-size: .9rem; padding: 8px 0; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
</head>
<body>
<header>
  <h1>福岡市 中古マンション ウォッチ</h1>
  <div class="sub" id="period">読み込み中…</div>
  <div id="notices"></div>
</header>
<main>
  <section>
    <form id="filters">
      <label>区<select name="ward" id="f-ward"><option value="">全区</option></select></label>
      <label>築年帯<select name="age">
        <option value="all">すべて</option><option value="0-10">築0-10年</option><option value="10-20">築10-20年</option>
        <option value="20-30">築20-30年</option><option value="30+">築30年超</option></select></label>
      <label>価格 下限（万円）<input name="pmin" type="number" inputmode="numeric" min="0" step="100"></label>
      <label>価格 上限（万円）<input name="pmax" type="number" inputmode="numeric" min="0" step="100"></label>
      <label>面積 下限（㎡）<input name="amin" type="number" inputmode="numeric" min="0" step="5"></label>
      <label>面積 上限（㎡）<input name="amax" type="number" inputmode="numeric" min="0" step="5"></label>
      <label>価格の種類<select name="cat">
        <option value="transaction">取引価格（2005〜）</option><option value="contract">成約価格（2021〜）</option><option value="all">両方（重複の恐れ）</option></select></label>
      <label>推移の期間<select name="years"><option value="5">5年</option><option value="10" selected>10年</option><option value="15">15年</option><option value="20">20年</option></select></label>
      <button type="submit">更新</button>
    </form>
  </section>

  <section>
    <h2>区ごとの「売りやすさ」と「貸しやすさ」</h2>
    <div class="formula" id="f-sell"></div>
    <div class="formula" id="f-rent"></div>
    <div class="scroll"><table id="t-ward"></table></div>
  </section>

  <section>
    <h2>売れやすさ候補（地区）</h2>
    <div class="sub">売りやすさの高い順。貸しやすさは所属する区の値。</div>
    <div class="scroll"><table id="t-district"></table></div>
  </section>

  <section>
    <h2>㎡単価の中央値の推移（価格維持）</h2>
    <div class="chart"><canvas id="c-trend"></canvas></div>
  </section>

  <section>
    <h2>取引件数（四半期・流動性）</h2>
    <div class="chart"><canvas id="c-count"></canvas></div>
  </section>

  <section>
    <h2>築年帯別の㎡単価（直近8四半期・値下がりの速さ）</h2>
    <div class="chart"><canvas id="c-age"></canvas></div>
  </section>

  <section>
    <h2>価格帯の分布</h2>
    <div class="chart"><canvas id="c-price"></canvas></div>
  </section>

  <section>
    <h2>賃貸需要の指標（区）</h2>
    <div class="scroll"><table id="t-rent"></table></div>
  </section>

  <section>
    <h2>駅の乗降客数（福岡市とその周辺）</h2>
    <div class="sub">国土数値情報 S12（不動産情報ライブラリ XKT015）。区とのひも付けはしていない。</div>
    <div class="scroll"><table id="t-station"></table></div>
  </section>
</main>
<footer class="sub">
  出典: 国土交通省「不動産情報ライブラリ」（不動産取引価格情報・成約価格情報・将来推計人口・駅別乗降客数）、政府統計の総合窓口 e-Stat。
  このサービスは、国土交通省不動産情報ライブラリのAPI機能を使用していますが、提供情報の最新性、正確性、完全性等が保証されたものではありません。
  取引価格の駅距離は XIT001 に含まれないため表示していません。
</footer>
<script>
(function () {
  var COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04"];
  var charts = {};
  var form = document.getElementById("filters");

  function qiLabel(qi) { return Math.floor(qi / 4) + "Q" + (qi % 4 + 1); }
  function man(v, d) { return v == null ? "—" : (v / 10000).toFixed(d == null ? 1 : d); }
  function pct(v) { return v == null ? "—" : v.toFixed(1) + "%"; }
  function ratio(v) { return v == null ? "—" : (v * 100).toFixed(0) + "%"; }
  function num(v, d) { return v == null ? "—" : Number(v).toFixed(d || 0); }
  function wardName(d, code) { for (var i = 0; i < d.wards.length; i++) if (d.wards[i].code === code) return d.wards[i].name; return code; }

  function fillTable(id, headers, rows, emptyText) {
    var t = document.getElementById(id);
    t.textContent = "";
    if (!rows.length) {
      var tr0 = t.insertRow(); var td0 = tr0.insertCell(); td0.className = "empty l"; td0.textContent = emptyText || "データなし"; return;
    }
    var head = t.createTHead().insertRow();
    headers.forEach(function (h) { var th = document.createElement("th"); th.textContent = h.label; if (h.left) th.className = "l"; head.appendChild(th); });
    var body = t.createTBody();
    rows.forEach(function (r) {
      var tr = body.insertRow();
      headers.forEach(function (h, i) {
        var td = tr.insertCell(); td.textContent = r[i] == null ? "—" : String(r[i]);
        if (h.left) td.className = "l"; if (h.score) td.className = "score";
      });
    });
  }

  function drawChart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    if (typeof Chart === "undefined") return;
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } } } }, config.options || {});
    charts[id] = new Chart(document.getElementById(id), config);
  }

  function render(d) {
    var notices = document.getElementById("notices");
    notices.textContent = "";
    d.status.notices.forEach(function (n) { var div = document.createElement("div"); div.className = "notice"; div.textContent = n; notices.appendChild(div); });
    d.status.recentErrors.forEach(function (e) {
      var div = document.createElement("div"); div.className = "notice";
      div.textContent = "取り込みエラー " + wardName(d, e.ward_code) + " " + e.year + "Q" + e.quarter + ": " + (e.error || "");
      notices.appendChild(div);
    });
    document.getElementById("period").textContent =
      (d.status.rows ? "収録 " + qiLabel(d.status.firstQi) + "〜" + qiLabel(d.status.latestQi) + "・" + d.status.rows + "件" : "取引データなし") +
      (d.status.lastFetchedAt ? "・最終取り込み " + new Date(d.status.lastFetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "");
    document.getElementById("f-sell").textContent = d.formulas.sell;
    document.getElementById("f-rent").textContent = d.formulas.rent;

    fillTable("t-ward",
      [{ label: "区", left: true }, { label: "売りやすさ", score: true }, { label: "貸しやすさ", score: true }, { label: "件数/年" },
       { label: "価格維持" }, { label: "㎡単価(万)" }, { label: "築20-30/築0-10" }, { label: "賃貸指標" }],
      d.wardScores.map(function (w) {
        return [w.name, w.sellScore, w.rentScore, num(w.liquidity), ratio(w.retention), man(w.medRecent), ratio(w.age20to30VsNew),
          w.rentUsed.length + "/" + d.rentComponentDefs.length];
      }));

    fillTable("t-district",
      [{ label: "区", left: true }, { label: "地区", left: true }, { label: "売りやすさ", score: true }, { label: "貸しやすさ(区)" },
       { label: "件数/年" }, { label: "㎡単価(万)" }, { label: "価格維持" }, { label: "前期件数" }],
      d.districts.map(function (x) {
        return [wardName(d, x.ward_code), x.district, x.sellScore, x.rentScore, num(x.liquidity, 1), man(x.medRecent), ratio(x.retention), x.nPrior];
      }), "取引データなし");

    var qis = []; d.trend.forEach(function (r) { if (qis.indexOf(r.qi) < 0) qis.push(r.qi); }); qis.sort(function (a, b) { return a - b; });
    var wardsShown = d.wards.filter(function (w) { return !d.filters.ward || w.code === d.filters.ward; });
    function series(field, scale) {
      return wardsShown.map(function (w) {
        var idx = d.wards.indexOf(w);
        return {
          label: w.name, borderColor: COLORS[idx], backgroundColor: COLORS[idx], tension: 0.25, pointRadius: 0, spanGaps: true,
          data: qis.map(function (q) { for (var i = 0; i < d.trend.length; i++) { var r = d.trend[i]; if (r.ward_code === w.code && r.qi === q) return r[field] / scale; } return null; })
        };
      });
    }
    var labels = qis.map(qiLabel);
    drawChart("c-trend", { type: "line", data: { labels: labels, datasets: series("med", 10000) },
      options: { scales: { y: { title: { display: true, text: "万円/㎡" } } } } });
    drawChart("c-count", { type: "bar", data: { labels: labels, datasets: series("n", 1) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "件" } } } } });

    drawChart("c-age", { type: "bar", data: {
      labels: d.ageBandDefs.map(function (b) { return b.label; }),
      datasets: d.wards.map(function (w, idx) {
        return { label: w.name, backgroundColor: COLORS[idx], data: d.ageBandDefs.map(function (b) {
          for (var i = 0; i < d.ageBands.length; i++) { var r = d.ageBands[i]; if (r.ward_code === w.code && r.band === b.id) return r.med / 10000; } return null; }) };
      }) }, options: { scales: { y: { title: { display: true, text: "万円/㎡" } } } } });

    drawChart("c-price", { type: "bar", data: {
      labels: wardsShown.map(function (w) { return w.name; }),
      datasets: d.priceBandDefs.map(function (b, idx) {
        return { label: b.label, backgroundColor: "hsl(" + (210 - idx * 28) + " 70% 55%)", data: wardsShown.map(function (w) {
          var total = 0, n = 0;
          d.priceBands.forEach(function (r) { if (r.ward_code === w.code) { total += r.n; if (r.band === b.id) n = r.n; } });
          return total ? Math.round(1000 * n / total) / 10 : 0; }) };
      }) }, options: { indexAxis: "y", scales: { x: { stacked: true, max: 100, title: { display: true, text: "%" } }, y: { stacked: true } } } });

    fillTable("t-rent",
      [{ label: "区", left: true }].concat(d.rentComponentDefs.map(function (c) { return { label: c.label + (c.higherIsBetter ? "" : "（低いほど良い）") }; })),
      d.wardScores.map(function (w) { return [w.name].concat(d.rentComponentDefs.map(function (c) { return pct(w.components[c.id]); })); }));

    fillTable("t-station",
      [{ label: "駅", left: true }, { label: "事業者", left: true }, { label: "路線", left: true }, { label: "乗降客数/日" }, { label: "年度" }, { label: "対2019" }, { label: "対初年" }],
      d.stations.map(function (s) { return [s.name, s.operator, s.line, s.latest, s.latestYear, ratio(s.vs2019), ratio(s.vsFirst)]; }),
      "未取得（scripts/load-geo.ts を実行）");
  }

  function load() {
    var params = new URLSearchParams(new FormData(form));
    history.replaceState(null, "", "?" + params.toString());
    fetch("/api/metrics?" + params.toString())
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function (e) { document.getElementById("period").textContent = "読み込みに失敗しました: " + e.message; });
  }

  var wardSel = document.getElementById("f-ward");
  [["40131","東区"],["40132","博多区"],["40133","中央区"],["40134","南区"],["40135","西区"],["40136","城南区"],["40137","早良区"]].forEach(function (w) {
    var o = document.createElement("option"); o.value = w[0]; o.textContent = w[1]; wardSel.appendChild(o);
  });
  new URLSearchParams(location.search).forEach(function (v, k) { var elm = form.elements.namedItem(k); if (elm && "value" in elm) elm.value = v; });
  form.addEventListener("submit", function (e) { e.preventDefault(); load(); });
  load();
})();
</script>
</body>
</html>`;

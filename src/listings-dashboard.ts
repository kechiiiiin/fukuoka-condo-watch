// /listings（非公開・Cloudflare Access 保護）。データは /api/listings/metrics と /api/listings/status。
// ⚠️ クライアント側スクリプトではバッククォートと「ドル記号+波括弧」を使わない（この TS テンプレートに展開されてしまう）。

export function renderListingsDashboard(): string {
  return HTML;
}

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>掲載ウォッチ（非公開）</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1f2328; --muted:#667085; --line:#e4e4e0; --accent:#2563eb; --warn:#b45309; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --ink:#e8e8e6; --muted:#9aa3af; --line:#30343c; --accent:#60a5fa; --warn:#f59e0b; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header, main, footer { max-width: 1100px; margin: 0 auto; padding: 12px 14px; }
  h1 { font-size: 1.25rem; margin: 8px 0 4px; }
  h2 { font-size: 1.05rem; margin: 0 0 8px; }
  a { color: var(--accent); }
  .sub { color: var(--muted); font-size: .85rem; }
  .notice { background: color-mix(in srgb, var(--warn) 14%, transparent); border-left: 4px solid var(--warn); padding: 6px 10px; margin: 6px 0; border-radius: 4px; font-size: .9rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  label { display: flex; flex-direction: column; font-size: .8rem; color: var(--muted); gap: 2px; }
  select, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); }
  button { background: var(--accent); color: #fff; border: none; font-weight: 600; }
  .formula { font-size: .82rem; color: var(--muted); background: var(--bg); padding: 6px 8px; border-radius: 6px; margin: 4px 0 8px; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; white-space: nowrap; }
  th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: right; }
  th:first-child, td:first-child, th.l, td.l { text-align: left; }
  th { font-weight: 600; color: var(--muted); background: var(--card); }
  .chart { position: relative; height: 260px; }
  .bad { color: var(--bad); font-weight: 600; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
</head>
<body>
<header>
  <h1>中古マンション 掲載ウォッチ（SUUMO・非公開）</h1>
  <div class="sub">私的・非商用の個人利用。公開ダッシュボードは <a href="/">/</a>（国交省の公開データのみ）・<a href="/listings/picks">条件に合う新着・掲載中の物件 →</a></div>
  <div class="sub" id="period">読み込み中…</div>
  <div id="notices"></div>
</header>
<main>
  <section>
    <form id="filters">
      <label>範囲<select name="scope"><option value="all">すべて</option><option value="city">福岡市のみ</option><option value="suburb">近郊のみ</option></select></label>
      <label>期間<select name="days"><option value="30">30 日</option><option value="90" selected>90 日</option><option value="180">180 日</option><option value="365">1 年</option></select></label>
      <button type="submit">表示</button>
    </form>
  </section>
  <section>
    <h2>市区町村別</h2>
    <div class="formula">掲載日数 = 最後に見えた日 − 初出日 + 1（掲載終了した物件の中央値。最初の完走回に既にあった物件は開始日が不明なので除外）。値下げ率 = 期間内に掲載されていた物件のうち値下げを 1 回以上観測した割合。売出/成約 = 掲載中の㎡単価中央値 ÷ 成約価格（2021〜）の直近8四半期の㎡単価中央値と比較。時点・構成が違うので乖離の目安。成約の件数が20件未満（ダッシュボードの売りやすさと同じ最低件数）の市区町村は「件数不足」として比を出さない。</div>
    <div class="scroll"><table id="t-area"></table></div>
  </section>
  <section>
    <h2>築年帯別</h2>
    <div class="scroll"><table id="t-age"></table></div>
  </section>
  <section>
    <h2>価格帯別</h2>
    <div class="scroll"><table id="t-price"></table></div>
  </section>
  <section>
    <h2>日ごとの新着・掲載終了</h2>
    <div class="chart"><canvas id="c-daily"></canvas></div>
  </section>
  <section>
    <h2>クロールの状態</h2>
    <div class="sub" id="crawl-state"></div>
    <div class="scroll"><table id="t-runs"></table></div>
    <div class="scroll"><table id="t-events"></table></div>
  </section>
</main>
<footer class="sub">掲載情報の出典: SUUMO（株式会社リクルート）。取引価格: 国土交通省 不動産情報ライブラリ。</footer>
<script>
(function () {
  var chart = null;
  function esc(v) { return String(v === null || v === undefined ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function n(v, d) { if (v === null || v === undefined) return "—"; return Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d || 0 }); }
  function pct(v) { return v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%"; }
  function table(el, head, rows) {
    var h = "<thead><tr>" + head.map(function (c, i) { return "<th" + (i === 0 ? ' class="l"' : "") + ">" + esc(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
    h += rows.map(function (r) { return "<tr>" + r.map(function (c, i) { return "<td" + (i === 0 ? ' class="l"' : "") + ">" + c + "</td>"; }).join("") + "</tr>"; }).join("");
    document.getElementById(el).innerHTML = h + "</tbody>";
  }
  var COMMON = ["掲載中", "期間内 掲載終了", "掲載日数 中央値", "(n)", "掲載中の経過日数 中央値", "値下げ率", "新着/日", "売出価格 中央値(万円)", "売出㎡単価 中央値(円)"];
  function common(s) { return [n(s.active), n(s.delisted), n(s.domMedian, 1), n(s.domN), n(s.activeAgeMedian, 1), pct(s.priceCutRate), n(s.newPerDay, 1), n(s.askPriceMedianMan), n(s.askUnitMedian)]; }
  function load() {
    var params = new URLSearchParams(new FormData(document.getElementById("filters")));
    fetch("/api/listings/metrics?" + params.toString(), { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (m) {
      document.getElementById("period").textContent = m.since + " 〜 " + m.today + "（ベースライン " + (m.baseline || "未") + "・完走 " + m.completeRuns + " 回）" + (m.txPeriod ? "／成約価格（2021〜）は " + m.txPeriod.year + "Q" + m.txPeriod.quarter + " までの " + m.txPeriod.quarters + " 四半期" : "");
      document.getElementById("notices").innerHTML = m.notices.map(function (t) { return '<div class="notice">' + esc(t) + "</div>"; }).join("");
      table("t-area", ["市区町村"].concat(COMMON, ["成約㎡単価 中央値(円)", "(成約n)", "売出/成約"]), m.areas.map(function (a) {
        return [esc(a.name) + ' <span class="sub">' + esc(a.subgroup) + "</span>"].concat(common(a), [n(a.txUnitMedian), n(a.txN), a.askToTx === null ? (a.txStatus === "few_sales" ? "件数不足" : "—") : a.askToTx.toFixed(2)]);
      }).concat([["<b>合計</b>"].concat(common(m.overall), ["", "", ""])]));
      table("t-age", ["築年帯"].concat(COMMON), m.ageBands.map(function (b) { return [esc(b.label)].concat(common(b)); }));
      table("t-price", ["価格帯"].concat(COMMON), m.priceBands.map(function (b) { return [esc(b.label)].concat(common(b)); }));
      var labels = m.daily.map(function (d) { return d.date; });
      if (chart) chart.destroy();
      if (window.Chart) {
        chart = new Chart(document.getElementById("c-daily"), {
          type: "bar",
          data: { labels: labels, datasets: [
            { label: "新着", data: m.daily.map(function (d) { return d.fresh; }) },
            { label: "掲載終了", data: m.daily.map(function (d) { return -d.gone; }) }
          ] },
          options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } } }
        });
      }
    }).catch(function (e) {
      document.getElementById("notices").innerHTML = '<div class="notice">読み込み失敗: ' + esc(e.message) + "</div>";
    });
    fetch("/api/listings/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (s) {
      var st = s.state || {};
      var cool = st.cooldown_until && st.cooldown_until > new Date().toISOString();
      document.getElementById("crawl-state").innerHTML = "LISTINGS_ENABLED: <b>" + (s.enabled ? "on" : "off") + "</b>・cron " + esc(s.cron) + "・間隔 " + n(s.settings.intervalMs) + "ms・最終取得 " + esc(st.last_fetch_at || "—") + "・最終 cron 起動 " + esc((s.lastCronRun && s.lastCronRun.at) || "—") + (cool ? ' ・<span class="bad">クールダウン中 ' + esc(st.cooldown_until) + "（" + esc(st.last_block_kind) + "）</span>" : "");
      table("t-runs", ["日付", "状態", "起動", "ページ", "見えた件数", "ヒット合計", "新着", "価格変更", "掲載終了", "メモ"], s.runs.map(function (r) {
        return [esc(r.crawl_date), r.status === "blocked" ? '<span class="bad">blocked</span>' : esc(r.status), n(r.invocations), n(r.pages_fetched), n(r.listings_seen), n(r.total_hits), n(r.new_count), n(r.price_change_count), n(r.gone_count), '<span class="sub">' + esc(r.note) + "</span>"];
      }));
      table("t-events", ["時刻", "種別", "HTTP", "内容"], s.events.map(function (e) {
        return [esc(e.at), esc(e.kind), esc(e.http_status), '<span class="sub">' + esc(e.url || "") + " " + esc((e.detail || "").slice(0, 160)) + "</span>"];
      }));
    }).catch(function () {});
  }
  document.getElementById("filters").addEventListener("submit", function (ev) { ev.preventDefault(); load(); });
  load();
})();
</script>
</body>
</html>`;

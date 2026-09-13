// ローカル確認用の「SUUMO っぽい」偽サーバ。本物には一切アクセスしない。
// 物件データは架空（乱数ではなく決定的に生成）。HTML の骨格は 2026-09-14 に実ページで確かめた構造（src/suumo.ts 冒頭）に合わせてある。
//
//   npm run fake-suumo                        # http://127.0.0.1:8790
//   curl -X POST http://127.0.0.1:8790/__day/2      # 2 日目: 一部が消える・値下げ・新着
//   curl -X POST http://127.0.0.1:8790/__mode/429   # 以後 429 を返す（ok / 403 / 429 / captcha / broken）
//   curl http://127.0.0.1:8790/__stats              # 受けたリクエスト数

import { createServer } from "node:http";

const SLUGS = [
  "fukuokashihigashi", "fukuokashihakata", "fukuokashichuo", "fukuokashiminami", "fukuokashinishi",
  "fukuokashijonan", "fukuokashisawara", "chikushino", "kasuga", "onojo", "dazaifu", "nakagawa", "itoshima",
  "munakata", "koga", "fukutsu", "kasuyagunumi", "kasuyagunsasaguri", "kasuyagunshime", "kasuyagunsue",
  "kasuyagunshingu", "kasuyagunhisayama", "kasuyagunkasuya",
];
const ADDR: Record<string, string> = {
  fukuokashihigashi: "福岡市東区", fukuokashihakata: "福岡市博多区", fukuokashichuo: "福岡市中央区",
  fukuokashiminami: "福岡市南区", fukuokashinishi: "福岡市西区", fukuokashijonan: "福岡市城南区",
  fukuokashisawara: "福岡市早良区", chikushino: "筑紫野市", kasuga: "春日市", onojo: "大野城市", dazaifu: "太宰府市",
  nakagawa: "那珂川市", itoshima: "糸島市", munakata: "宗像市", koga: "古賀市", fukutsu: "福津市",
  kasuyagunumi: "糟屋郡宇美町", kasuyagunsasaguri: "糟屋郡篠栗町", kasuyagunshime: "糟屋郡志免町",
  kasuyagunsue: "糟屋郡須惠町", kasuyagunshingu: "糟屋郡新宮町", kasuyagunhisayama: "糟屋郡久山町", kasuyagunkasuya: "糟屋郡粕屋町",
};

export interface FakeListing {
  id: string;
  priceMan: number;
  area: number;
  built: string;
  walk: number;
}

/** slug・日ごとの架空の物件。1 日目は slug 番号 × 3 + 1 件（久山町は 0 件）。2 日目は 1/5 が消え、1/7 が値下げ、新着 2 件 */
export function fakeListings(slug: string, day: number): FakeListing[] {
  const idx = SLUGS.indexOf(slug);
  if (idx < 0 || slug === "kasuyagunhisayama") return [];
  const base = idx * 3 + 1;
  const out: FakeListing[] = [];
  for (let i = 0; i < base; i++) {
    if (day >= 2 && i % 5 === 4) continue;
    const cut = day >= 2 && i % 7 === 3;
    out.push({
      id: String(90000000 + idx * 1000 + i),
      priceMan: 1500 + ((i * 137) % 3000) - (cut ? 100 : 0),
      area: 40 + ((i * 7) % 50) + 0.25,
      built: `${1980 + ((i * 3) % 45)}年${1 + (i % 12)}月`,
      walk: 1 + ((i * 5) % 20),
    });
  }
  if (day >= 2) {
    for (let j = 0; j < 2; j++) {
      out.push({ id: String(95000000 + idx * 1000 + j), priceMan: 2222, area: 55.5, built: "2015年3月", walk: 6 });
    }
  }
  return out;
}

function unit(slug: string, l: FakeListing): string {
  return `<div class="property_unit property_unit--osusume">
  <div class="property_unit-content">
    <h2 class="property_unit-title"><a href="/ms/chuko/fukuoka/sc_${slug}/nc_${l.id}/" target="_blank">架空の物件 ${l.id}</a></h2>
    <div class="dottable dottable--cassette">
      <div class="dottable-line"><dl><dt class="dottable-vm">物件名</dt><dd class="dottable-vm">テスト&nbsp;マンション${l.id.slice(-3)}</dd></dl></div>
      <div class="dottable-line"><dl><dt class="dottable-vm">販売価格</dt><dd class="dottable-vm"><span class="dottable-value">${l.priceMan >= 10000 ? `${Math.floor(l.priceMan / 10000)}億${l.priceMan % 10000 || ""}` : l.priceMan}万円</span></dd></dl></div>
      <div class="dottable-line"><dl><dt>所在地</dt><dd>福岡県${ADDR[slug] ?? ""}テスト１</dd></dl><dl><dt>沿線・駅</dt><dd>ＪＲ鹿児島本線「テスト」徒歩${l.walk}分</dd></dl></div>
      <div class="dottable-line"><table class="dottable-fix"><tbody><tr>
        <td><dl><dt>専有面積</dt><dd>${l.area}m<sup>2</sup>（壁芯）</dd></dl></td><td><dl><dt>間取り</dt><dd>３ＬＤＫ</dd></dl></td>
      </tr></tbody></table></div>
      <div class="dottable-line"><table class="dottable-fix"><tbody><tr>
        <td><dl><dt>バルコニー</dt><dd>-</dd></dl></td><td><dl><dt>築年月</dt><dd>${l.built}</dd></dl></td>
      </tr></tbody></table></div>
    </div>
  </div>
</div>`;
}

export function renderFakePage(slug: string, page: number, day: number): { status: number; html: string } {
  if (!SLUGS.includes(slug)) return { status: 404, html: "<html><body>not found</body></html>" };
  const all = fakeListings(slug, day);
  if (all.length === 0) {
    return {
      status: 200,
      html: `<html><body><form><input type="hidden" name="sc" value="40348" /></form><div class="error_pop"><div class="error_pop-txt">条件にあう物件がありません。条件を変更して再度検索してください。</div></div></body></html>`,
    };
  }
  const pages = Math.ceil(all.length / 20);
  if (page > pages) return { status: 404, html: "<html><body>not found</body></html>" };
  const items = all.slice((page - 1) * 20, page * 20);
  const pager = Array.from({ length: pages }, (_, i) => i + 1)
    .map((p) => (p === page ? `<li class="pagination-current">${p}</li>` : `<li><a href="/ms/chuko/fukuoka/sc_${slug}/?page=${p}">${p}</a></li>`))
    .join("");
  return {
    status: 200,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="pagination_set"><div class="pagination_set-hit">
  ${all.length.toLocaleString("en-US")}<span>件</span>
</div><div class="pagination pagination_set-nav"><ol class="pagination-parts">${pager}</ol></div></div>
<div id="js-bukkenList" class="property_unit_group">
${items.map((l) => unit(slug, l)).join("\n")}
</div></body></html>`,
  };
}

function main(): void {
  const port = Number(process.env.FAKE_SUUMO_PORT ?? 8790);
  let day = 1;
  let mode = "ok";
  let hits = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.method === "POST" && u.pathname.startsWith("/__day/")) {
      day = Number(u.pathname.slice(7)) || 1;
      return send(200, JSON.stringify({ day }), "application/json");
    }
    if (req.method === "POST" && u.pathname.startsWith("/__mode/")) {
      mode = u.pathname.slice(8);
      return send(200, JSON.stringify({ mode }), "application/json");
    }
    if (u.pathname === "/__stats") return send(200, JSON.stringify({ day, mode, hits }), "application/json");
    const m = /^\/ms\/chuko\/fukuoka\/sc_([a-z]+)\/$/.exec(u.pathname);
    if (!m || !m[1]) return send(404, "not found");
    hits++;
    if (mode === "403") return send(403, "forbidden");
    if (mode === "429") return send(429, "too many requests");
    if (mode === "captcha") return send(200, "<html><body><div class='g-recaptcha'></div>アクセスが集中しています</body></html>");
    if (mode === "broken") return send(200, "<html><body>maintenance</body></html>");
    const r = renderFakePage(m[1], Number(u.searchParams.get("page") ?? 1), day);
    return send(r.status, r.html);
  });
  server.listen(port, "127.0.0.1", () => console.log(`fake SUUMO on http://127.0.0.1:${port} (day=${day})`));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

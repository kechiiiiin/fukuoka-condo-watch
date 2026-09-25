// ローカル確認用の「SUUMO っぽい」偽サーバ。本物には一切アクセスしない。
// 物件データは架空（乱数ではなく決定的に生成）。HTML の骨格は 2026-09-14 に実ページで確かめた構造（src/suumo.ts 冒頭）に合わせてある。
//
//   npm run fake-suumo                        # http://127.0.0.1:8790
//   curl -X POST http://127.0.0.1:8790/__day/2      # 2 日目: 一部が消える・値下げ・新着
//   curl -X POST http://127.0.0.1:8790/__mode/429   # 以後 429 を返す（ok / 403 / 429 / captcha / broken）
//   curl http://127.0.0.1:8790/__stats              # 受けたリクエスト数
//
// 賃貸（/chintai/fukuoka/sc_<slug>/）も返す。骨格は src/suumo-chintai.ts 冒頭の構造（**実ページ未検証**）。
// 新築（/ms/shinchiku/fukuoka/sc_<slug>/）も返す。骨格は 2026-09-22 に実ページで確かめた構造（src/suumo-shinchiku.ts 冒頭）。
//   - 博多区は 35 件（2 ページ）・3 つに 1 つの市区町村は 0 件（0 件ページには実物と同じく「近い物件」として他の市区町村の物件が並ぶ）
//   - 2 日目（__day/2）: 一部が消える・値下げ・価格未定だった物件に価格が付く・新着 1 件

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

// ---------------------------------------------------------------- 新築（/ms/shinchiku/）

export interface FakeNewListing {
  id: string;
  kbn: "4" | "8";
  name: string;
  /** 万円。null = 価格未定 */
  priceMin: number | null;
  priceMax: number | null;
  tentative: boolean;
  label: string | null;
  areaMin: number;
  areaMax: number;
  delivery: string;
  walk: number;
}

/** slug・日ごとの架空の新築。3 つに 1 つの市区町村（と久山町）は 0 件、博多区は 35 件 */
export function fakeNewListings(slug: string, day: number): FakeNewListing[] {
  const idx = SLUGS.indexOf(slug);
  if (idx < 0 || slug === "kasuyagunhisayama" || idx % 3 === 2) return [];
  const count = slug === "fukuokashihakata" ? 35 : (idx % 5) + 1;
  const out: FakeNewListing[] = [];
  for (let i = 0; i < count; i++) {
    if (day >= 2 && i % 6 === 5) continue; // 完売・掲載終了
    const unit = i % 4 === 3;
    const undecided = !unit && i % 5 === 2 && day < 2; // 2 日目に価格が決まる
    const base = 3500 + i * 250 + idx * 20 - (day >= 2 && i % 4 === 1 ? 100 : 0);
    const areaMin = 60.5 + (i % 4) * 5;
    out.push({
      id: String((unit ? 21000000 : 67000000) + idx * 1000 + i),
      kbn: unit ? "8" : "4",
      name: `架空レジデンス${idx}-${i}`,
      priceMin: undecided ? null : base,
      priceMax: undecided ? null : unit ? base : base + 800,
      tentative: !unit && i % 7 === 4,
      label: unit ? null : ["先着順", "第1期", "最終期", "第2期2次"][i % 4] ?? null,
      areaMin,
      areaMax: unit ? areaMin : areaMin + 15,
      delivery: unit ? "相談" : i % 3 === 0 ? "即引渡可" : `${2027 + (i % 2)}年${1 + (i % 12)}月下旬予定`,
      walk: 2 + ((i * 3) % 15),
    });
  }
  if (day >= 2 && count > 0) {
    out.push({
      id: String(67900000 + idx), kbn: "4", name: `新着レジデンス${idx}`, priceMin: 4200, priceMax: 5100, tentative: false,
      label: "第1期", areaMin: 70.1, areaMax: 85.2, delivery: "2028年3月下旬予定", walk: 5,
    });
  }
  return out;
}

function manText(v: number): string {
  return v >= 10000 ? `${Math.floor(v / 10000)}億${v % 10000 || ""}万円` : `${v}万円`;
}

function newUnit(slug: string, l: FakeNewListing): string {
  const addr = ADDR[slug] ?? "";
  const price =
    l.priceMin === null ? "価格未定" : l.priceMin === l.priceMax ? manText(l.priceMin) : `${manText(l.priceMin)}～${manText(l.priceMax!)}${l.tentative ? "／予定" : ""}`;
  const area = l.areaMin === l.areaMax ? `${l.areaMin}m<sup>2</sup>（壁芯）` : `${l.areaMin}m<sup>2</sup>～${l.areaMax}m<sup>2</sup>`;
  const plan =
    l.kbn === "4" && l.priceMin !== null
      ? `<ul class="cassette_plantable-list js-noCassetteLink"><li class="cassette_plantable-list_item js-madoriType js-taplog" data-madoritype="001">
<a href="/ms/shinchiku/fukuoka/sc_${slug}/nc_${l.id}/rooms/" class="cassette_plantable-link"><div class="cassette_plantable-left">
<p class="cassette_plantable-price">${manText(l.priceMin)}</p>
<p class="cassette_plantable-layout">3LDK&nbsp;/&nbsp;${l.areaMin}m<sup>2</sup></p>
</div><p class="cassette_plantable-type">タイプ：A</p></a></li></ul>`
      : "";
  return `<li class="cassette_list-item"><div class="cassette property_unit">
<div class="cassette-check"><input class="js-keisaiKbn" type="hidden" value="${l.kbn}" /></div>
<div class="cassette-content js-normalLink js-cassetLink js-cassette_content">
<div class="cassette_header"><h2>
<a href="/ms/shinchiku/fukuoka/sc_${slug}/nc_${l.id}/" class="cassette_header-title js-cassetLinkHref js-cassette_title">${l.name}</a></h2></div>
<div class="cassette-result_detail"><div class="cassette_basic"><ul class="cassette_basic-list">
<li class="cassette_basic-list_item"><div class="cassette_basic-item"><p class="cassette_basic-title">所在地</p><p class="cassette_basic-value">${l.kbn === "8" ? "福岡県" : ""}${addr}テスト２</p></div></li>
<li class="cassette_basic-list_item"><div class="cassette_basic-item"><p class="cassette_basic-title">交通</p><p class="cassette_basic-value">ＪＲ鹿児島本線/テスト 徒歩${l.walk}分</p></div></li>
<li class="cassette_basic-list_item"><div class="cassette_basic-item"><p class="cassette_basic-title">引渡時期</p><p class="cassette_basic-value">${l.delivery}</p></div></li>
</ul></div>
<div class="cassette_price cassette_price--layout"><ul class="cassette_price-list">
<li class="cassette_price-list_item"><div class="cassette_price-value"><span class="cassette_price-accent">
${price}</span>${l.label ? `&nbsp;（${l.label}）` : ""}
</div><p class="cassette_price-description">
3LDK
/
${area}</p></li></ul></div></div>
<div class="cassette-result_detail_table"><div class="cassette_plantable">${plan}</div></div>
</div></div></li>`;
}

export function renderFakeShinchikuPage(slug: string, page: number, day: number): { status: number; html: string } {
  if (!SLUGS.includes(slug)) return { status: 404, html: "<html><body>not found</body></html>" };
  const all = fakeNewListings(slug, day);
  if (all.length === 0) {
    // 実物どおり、0 件でも「近い物件」として他の市区町村の物件が property_unit で並ぶ（パーサはここを読まないこと）
    const other = "fukuokashihakata";
    return {
      status: 200,
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body><form><input type="hidden" name="sc" value="00000" /></form>
<div class="error_pop"><div class="error_pop-txt">条件にあう物件がありません。条件を変更して再度検索してください。</div></div>
<div class="ui-section--h2 item3"><div class="ui-section-header"><h2>近くの新築分譲マンション</h2></div></div>
<div class="ui-section--h2"><div class="ui-section-header"><h2>ここに近い新築分譲マンション</h2></div></div>
<div id="js-bukkenList"><ul class="cassette_list">${fakeNewListings(other, day).slice(0, 3).map((l) => newUnit(other, l)).join("\n")}</ul></div>
</body></html>`,
    };
  }
  const pageSize = 30;
  const pages = Math.ceil(all.length / pageSize);
  if (page > pages) return { status: 404, html: "<html><body>not found</body></html>" };
  const items = all.slice((page - 1) * pageSize, page * pageSize);
  const pager = Array.from({ length: pages }, (_, i) => i + 1)
    .map((p) =>
      p === page
        ? `<li class="sortbox_pagination-list sortbox_pagination--current">${p}</li>`
        : `<li class="sortbox_pagination-list"><a class="sortbox_pagination-link" href="/ms/shinchiku/fukuoka/sc_${slug}/${p > 1 ? `?page=${p}` : ""}">${p}</a></li>`,
    )
    .join("");
  return {
    status: 200,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<a href="/jj/bukken/ichiran/JJ011FC001/?ar=090&amp;bs=010&amp;pc=30&page=1" id="pcLink" class="dn"></a>
<form><div class="hitbox"><div class="hitbox-number">
  ${all.length}<span class="hitbox-item">件</span>
</div></div>
<!-- MsBukkenPager02 Start -->
<div class="sortbox_pagination">
<ol class="sortbox_pagination-parts">${pager}</ol>
</div>
<!-- MsBukkenPager02 End -->
<div id="js-bukkenList"><ul class="cassette_list cassette_list--layout">
${items.map((l) => newUnit(slug, l)).join("\n")}
</ul></div></form>
<ul><li><a href="/ms/shinchiku/fukuoka/sc_fukuokashichuo/?page=1&pc=30" rel="nofollow">福岡市中央区(9)</a></li></ul>
</body></html>`,
  };
}

// ---------------------------------------------------------------- 賃貸（/chintai/）

export interface FakeChintaiRoom {
  id: string;
  floor: number;
  rentMan: number;
  /** 管理費（円）。null = 「-」 */
  adminYen: number | null;
  /** 敷金の表記（"7.3万円" / "1ヶ月" / "-"） */
  deposit: string;
  gratuity: string;
  madori: string;
  area: number;
}

export interface FakeChintaiBuilding {
  name: string;
  age: number;
  floors: number;
  walk: number;
  pets: boolean;
  listedOn: string;
  rooms: FakeChintaiRoom[];
}

/** slug・日ごとの架空の賃貸。1 日目は (slug 番号 % 4) + 1 棟（久山町は 0 件）。2 日目は 1 棟消えて 1 棟増え、1 部屋が値下げ */
export function fakeChintaiBuildings(slug: string, day: number): FakeChintaiBuilding[] {
  const idx = SLUGS.indexOf(slug);
  if (idx < 0 || slug === "kasuyagunhisayama") return [];
  const count = (idx % 4) + 1;
  const out: FakeChintaiBuilding[] = [];
  for (let i = 0; i < count; i++) {
    if (day >= 2 && i === count - 1 && count > 1) continue;
    const rooms: FakeChintaiRoom[] = [];
    const nRooms = (i % 3) + 1;
    for (let j = 0; j < nRooms; j++) {
      const rent = 9 + ((i * 3 + j) % 8) + (day >= 2 && j === 0 ? -0.5 : 0);
      rooms.push({
        id: String(100000000000 + idx * 100000 + i * 100 + j).slice(-12),
        floor: 2 + j,
        rentMan: Math.round(rent * 10) / 10,
        adminYen: j % 3 === 2 ? null : 3000 + j * 1000,
        deposit: j % 3 === 0 ? "1ヶ月" : j % 3 === 1 ? `${Math.round(rent * 10) / 10}万円` : "-",
        gratuity: j % 2 === 0 ? "なし" : "1ヶ月",
        madori: ["3LDK", "4LDK", "3DK"][(i + j) % 3] ?? "3LDK",
        area: 70.5 + ((i * 5 + j * 3) % 30),
      });
    }
    out.push({
      name: `架空ハイツ${idx}-${i}`,
      age: (i * 7 + idx) % 40,
      floors: 5 + (i % 6),
      walk: 3 + ((i * 4) % 12),
      pets: i % 3 === 0,
      listedOn: `2026/9/${1 + ((idx + i) % 25)}`,
      rooms,
    });
  }
  if (day >= 2) {
    out.push({
      name: `新着ハイツ${idx}`, age: 3, floors: 10, walk: 4, pets: true, listedOn: "2026/10/1",
      rooms: [{ id: String(199000000000 + idx), floor: 7, rentMan: 12.5, adminYen: 6000, deposit: "12.5万円", gratuity: "1ヶ月", madori: "3LDK", area: 75.2 }],
    });
  }
  return out;
}

function chintaiRoomRow(r: FakeChintaiRoom): string {
  return `<tr class="js-cassette_link">
<td><div class="cassetteitem_other-checkbox"><input type="checkbox" /></div></td>
<td>${r.floor}階</td>
<td><ul>
  <li><span class="cassetteitem_other-emphasis cassetteitem_price cassetteitem_price--rent">${r.rentMan}万円</span></li>
  <li><span class="cassetteitem_price cassetteitem_price--administration">${r.adminYen === null ? "-" : `${r.adminYen}円`}</span></li>
</ul></td>
<td><ul>
  <li><span class="cassetteitem_price cassetteitem_price--deposit">${r.deposit}</span></li>
  <li><span class="cassetteitem_price cassetteitem_price--gratuity">${r.gratuity}</span></li>
</ul></td>
<td><ul>
  <li><span class="cassetteitem_madori">${r.madori}</span></li>
  <li><span class="cassetteitem_menseki">${r.area}m<sup>2</sup></span></li>
</ul></td>
<td><a class="js-cassette_link_href cassetteitem_other-linktext" href="/chintai/jnc_${r.id}/?bc=1234567890">詳細を見る</a></td>
</tr>`;
}

function chintaiBuilding(slug: string, b: FakeChintaiBuilding): string {
  return `<div class="cassetteitem">
<div class="cassetteitem_content">
  <div class="cassetteitem_content-label"><span class="ui-pct ui-pct--util1">賃貸マンション</span></div>
  <div class="cassetteitem_content-title">${b.name}</div>
  <div class="cassetteitem_content-body"><ul class="cassetteitem_detail">
    <li class="cassetteitem_detail-col1">福岡県${ADDR[slug] ?? ""}テスト３</li>
    <li class="cassetteitem_detail-col2">
      <div class="cassetteitem_detail-text">ＪＲ鹿児島本線/テスト駅 歩${b.walk}分</div>
      <div class="cassetteitem_detail-text">西鉄バス/テスト前 バス8分 停歩2分</div>
    </li>
    <li class="cassetteitem_detail-col3"><div>${b.age === 0 ? "新築" : `築${b.age}年`}</div><div>${b.floors}階建</div></li>
  </ul></div>
  <div class="cassetteitem_note">情報公開日：${b.listedOn}${b.pets ? " ／ ペット相談" : ""}</div>
</div>
<div class="cassetteitem-item"><table class="cassetteitem_other"><tbody>
${b.rooms.map(chintaiRoomRow).join("\n")}
</tbody></table></div>
</div>`;
}

export function renderFakeChintaiPage(slug: string, page: number, day: number): { status: number; html: string } {
  if (!SLUGS.includes(slug)) return { status: 404, html: "<html><body>not found</body></html>" };
  const all = fakeChintaiBuildings(slug, day);
  if (all.length === 0) {
    return {
      status: 200,
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="error_pop"><div class="error_pop-txt">条件にあう物件がありません。条件を変更して再度検索してください。</div></div>
</body></html>`,
    };
  }
  const pageSize = 30;
  const pages = Math.ceil(all.length / pageSize);
  if (page > pages) return { status: 404, html: "<html><body>not found</body></html>" };
  const items = all.slice((page - 1) * pageSize, page * pageSize);
  const rooms = all.reduce((n, b) => n + b.rooms.length, 0);
  const pager = Array.from({ length: pages }, (_, i) => i + 1)
    .map((p) => (p === page ? `<li class="pagination-current">${p}</li>` : `<li><a href="/chintai/fukuoka/sc_${slug}/?page=${p}">${p}</a></li>`))
    .join("");
  return {
    status: 200,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="paginate_set"><div class="paginate_set-hit">${rooms.toLocaleString("en-US")}<span>件</span></div>
<ol class="pagination-parts">${pager}</ol></div>
<div id="js-bukkenList">
${items.map((b) => chintaiBuilding(slug, b)).join("\n")}
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
    const m =
      /^\/ms\/(chuko|shinchiku)\/fukuoka\/sc_([a-z]+)\/$/.exec(u.pathname) ??
      /^\/(chintai)\/fukuoka\/sc_([a-z]+)\/$/.exec(u.pathname);
    if (!m || !m[1] || !m[2]) return send(404, "not found");
    hits++;
    if (mode === "403") return send(403, "forbidden");
    if (mode === "429") return send(429, "too many requests");
    if (mode === "captcha") return send(200, "<html><body><div class='g-recaptcha'></div>アクセスが集中しています</body></html>");
    if (mode === "broken") return send(200, "<html><body>maintenance</body></html>");
    const pageNo = Number(u.searchParams.get("page") ?? 1);
    const r =
      m[1] === "shinchiku"
        ? renderFakeShinchikuPage(m[2], pageNo, day)
        : m[1] === "chintai"
          ? renderFakeChintaiPage(m[2], pageNo, day)
          : renderFakePage(m[2], pageNo, day);
    return send(r.status, r.html);
  });
  server.listen(port, "127.0.0.1", () => console.log(`fake SUUMO on http://127.0.0.1:${port} (day=${day})`));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

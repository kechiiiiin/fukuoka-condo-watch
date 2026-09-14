// パーサと正規化のテスト。
// - 実ページ由来: ~/work/_experiments/listing-probe（suumo_sample.json と suburbs/*.html）。**リポジトリには入れない**
//   （SUUMO のコンテンツを public リポジトリで再配布しないため）。無ければ skip。LISTING_PROBE_DIR で場所を変えられる
// - 架空: scripts/fake-suumo-server.ts の生成 HTML（常に走る）
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeListings, renderFakePage } from "../scripts/fake-suumo-server.ts";
import {
  detectBlock,
  municipalityCodeFromAddress,
  parseAreaSqm,
  parseBuilt,
  parsePriceMan,
  parseStation,
  parseSuumoListPage,
  SUUMO_SLUGS,
  suumoSearchUrl,
  suumoTargets,
} from "../src/suumo.ts";
import { AREAS } from "../src/wards.ts";

const PROBE = process.env.LISTING_PROBE_DIR ?? join(homedir(), "work/_experiments/listing-probe");

test("価格 → 万円", () => {
  assert.equal(parsePriceMan("1790万円"), 1790);
  assert.equal(parsePriceMan("2,980万円"), 2980);
  assert.equal(parsePriceMan("1億2000万円"), 12000);
  assert.equal(parsePriceMan("1億円"), 10000);
  assert.equal(parsePriceMan("２９８０万円～３４８０万円"), 2980);
  assert.equal(parsePriceMan("価格未定"), null);
});

test("面積・築年月・駅", () => {
  assert.equal(parseAreaSqm("62.7m2（18.96坪）（壁芯）"), 62.7);
  assert.equal(parseAreaSqm("33m2（壁芯）"), 33);
  assert.equal(parseAreaSqm("70.5㎡"), 70.5);
  assert.deepEqual(parseBuilt("1989年4月"), { year: 1989, month: 4 });
  assert.deepEqual(parseBuilt("2001年"), { year: 2001, month: null });
  assert.deepEqual(parseStation("ＪＲ鹿児島本線「二日市」徒歩7分"), { line: "JR鹿児島本線", station: "二日市", walk: 7, bus: false });
  const bus = parseStation("西鉄天神大牟田線「春日原」バス10分停歩3分");
  assert.equal(bus.walk, null);
  assert.equal(bus.bus, true);
  assert.equal(bus.station, "春日原");
  // 路線名が「系統番号:区間」はバス停（駅と取り違えない）
  const route = parseStation("420:雑餉隈-板付「西月隈三丁目」徒歩4分");
  assert.equal(route.bus, true);
  assert.equal(route.walk, null);
  assert.equal(route.station, "西月隈三丁目");
});

test("住所 → 市区町村コード（旧字・糟屋郡を含む）", () => {
  assert.equal(municipalityCodeFromAddress("福岡県福岡市中央区輝国２"), "40133");
  assert.equal(municipalityCodeFromAddress("福岡県筑紫野市二日市南１"), "40217");
  assert.equal(municipalityCodeFromAddress("福岡県糟屋郡須惠町大字旅石"), "40344");
  assert.equal(municipalityCodeFromAddress("福岡県糟屋郡粕屋町仲原"), "40349");
  assert.equal(municipalityCodeFromAddress("福岡県北九州市小倉北区"), null);
});

test("スラッグ台帳は 23 市区町村すべて・URL の形", () => {
  assert.equal(suumoTargets().length, AREAS.length);
  for (const a of AREAS) assert.ok(SUUMO_SLUGS[a.code], a.name);
  assert.equal(suumoSearchUrl("fukuokashichuo", 1), "https://suumo.jp/ms/chuko/fukuoka/sc_fukuokashichuo/");
  assert.equal(suumoSearchUrl("kasuga", 3), "https://suumo.jp/ms/chuko/fukuoka/sc_kasuga/?page=3");
});

test("架空ページ: 件数・ページャ・0 件・止まるべき応答", () => {
  const all = fakeListings("kasuga", 1);
  const p1 = parseSuumoListPage(renderFakePage("kasuga", 1, 1).html, "40218");
  assert.equal(p1.totalHits, all.length);
  assert.equal(p1.listings.length, 20);
  assert.equal(p1.maxPageLinked, Math.ceil(all.length / 20));
  const l = p1.listings[0]!;
  assert.equal(l.municipalityCode, "40218");
  assert.equal(l.floorPlan, "3LDK");
  assert.equal(l.buildingName, "テスト マンション000");
  const zero = renderFakePage("kasuyagunhisayama", 1, 1).html;
  const z = parseSuumoListPage(zero);
  assert.equal(z.zeroHits, true);
  assert.equal(detectBlock(200, zero), null);
  assert.equal(detectBlock(429, ""), "http_429");
  assert.equal(detectBlock(403, ""), "http_403");
  assert.equal(detectBlock(200, "<div class='g-recaptcha'></div>アクセスが集中しています"), "captcha");
  assert.equal(detectBlock(200, "<html>maintenance</html>"), "unexpected_structure");
});

test("3xx: 別ホスト・ボット確認らしき先へのリダイレクトは止まる", () => {
  const url = suumoSearchUrl("kasuga", 1);
  const r = (location: string | null, status = 302) => detectBlock(status, "", { url, location });
  // 別ホスト
  assert.equal(r("https://captcha.example.com/?from=suumo"), "redirect_offsite");
  assert.equal(r("https://www.suumo.jp/ms/chuko/fukuoka/sc_kasuga/"), "redirect_offsite");
  assert.equal(r("http://[::1"), "redirect_offsite");
  // 同じホストのボット確認・拒否ページ
  assert.equal(r("/captcha?return=/ms/chuko/"), "redirect_challenge");
  assert.equal(r("https://suumo.jp/cdn-cgi/challenge-platform/h/b"), "redirect_challenge", "Cloudflare のチャレンジ");
  assert.equal(r("/error/access_denied.html", 301), "redirect_challenge");
  assert.equal(r("/"), "redirect_challenge", "検索結果の外（トップ）へ戻された");
  // 検索結果内の普通のリダイレクト（最終ページ超え等）は止めない
  assert.equal(r("/ms/chuko/fukuoka/sc_kasuga/"), null);
  assert.equal(r("https://suumo.jp/ms/chuko/fukuoka/sc_kasuga/?page=2", 301), null);
  // Location が無い・redirect 情報なしは従来どおり null（ページの失敗として数える）
  assert.equal(r(null), null);
  assert.equal(detectBlock(302, ""), null);
});

test("実データ: listing-probe の suumo_sample.json（福岡市中央区 20 件）の表記を正規化できる", { skip: !existsSync(join(PROBE, "suumo_sample.json")) }, () => {
  type Sample = { id: string; price: string; addr: string; built: string; area: string; station: string };
  const sample = JSON.parse(readFileSync(join(PROBE, "suumo_sample.json"), "utf8")) as Sample[];
  assert.equal(sample.length, 20);
  for (const s of sample) {
    assert.match(s.id, /^\d+$/);
    assert.ok(parsePriceMan(s.price), s.price);
    assert.ok(parseAreaSqm(s.area), s.area);
    assert.ok(parseBuilt(s.built).year, s.built);
    const st = parseStation(s.station);
    assert.ok(st.station, s.station);
    assert.ok(st.walk !== null || st.bus, s.station);
    assert.equal(municipalityCodeFromAddress(s.addr), "40133", s.addr);
  }
  assert.equal(parsePriceMan(sample[0]!.price), 950);
  assert.equal(parseAreaSqm(sample[3]!.area), 49.8);
});

const SUBURBS = join(PROBE, "suburbs");
test("実データ: 近郊 16 市町の保存 HTML を解析できる", { skip: !existsSync(SUBURBS) }, () => {
  const files = readdirSync(SUBURBS).filter((f) => /^sc_[a-z]+\.html$/.test(f));
  assert.ok(files.length >= 16);
  for (const f of files) {
    const slug = f.slice(3, -5);
    const code = Object.entries(SUUMO_SLUGS).find(([, s]) => s === slug)?.[0];
    assert.ok(code, `台帳に無いスラッグ ${slug}`);
    const html = readFileSync(join(SUBURBS, f), "utf8");
    assert.equal(detectBlock(200, html), null, f);
    assert.ok(html.includes(`name="sc" value="${code}"`), `${f} の sc が ${code} ではない`);
    const p = parseSuumoListPage(html, code);
    if (p.zeroHits) {
      assert.equal(p.listings.length, 0);
      continue;
    }
    assert.ok(p.totalHits !== null && p.totalHits > 0, f);
    assert.equal(p.listings.length, Math.min(20, p.totalHits!), f);
    for (const l of p.listings) {
      assert.ok(l.priceMan && l.priceMan > 0, `${f} ${l.externalId} 価格`);
      assert.ok(l.areaSqm && l.areaSqm > 5, `${f} ${l.externalId} 面積`);
      assert.ok(l.builtYear && l.builtYear > 1950, `${f} ${l.externalId} 築年`);
      assert.equal(l.municipalityCode, code, `${f} ${l.externalId} ${l.address}`);
      assert.ok(l.stationName, `${f} ${l.externalId} 駅`);
    }
  }
});

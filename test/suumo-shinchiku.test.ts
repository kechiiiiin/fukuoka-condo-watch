// 新築（/ms/shinchiku/）のパーサと正規化・取り込み要求のテスト。
// - 実ページ由来: ~/work/_experiments/listing-probe/shinchiku/（2026-09-22 取得の chuo_p1・kasuga_p1・munakata_p1・chuo_pc10_p2・city）。
//   **リポジトリには入れない**（SUUMO のコンテンツを public リポジトリで再配布しないため）。無ければ skip
// - 架空: scripts/fake-suumo-server.ts の生成 HTML（常に走る）
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderFakeShinchikuPage } from "../scripts/fake-suumo-server.ts";
import { classifyResponse, parseIngestRequest } from "../src/listing-crawl-core.ts";
import { detectBlock, SUUMO_SLUGS } from "../src/suumo.ts";
import {
  parseAreaRange,
  parseDelivery,
  parsePriceRangeMan,
  parseShinchikuListPage,
  parseShinchikuStation,
  ShinchikuSource,
  shinchikuSearchUrl,
  toNewListingRecord,
} from "../src/suumo-shinchiku.ts";

const PROBE = join(process.env.LISTING_PROBE_DIR ?? join(homedir(), "work/_experiments/listing-probe"), "shinchiku");

test("価格の幅 → 万円", () => {
  assert.deepEqual(parsePriceRangeMan("6590万円～1億2190万円"), { min: 6590, max: 12190, undecided: false, tentative: false });
  assert.deepEqual(parsePriceRangeMan("4,360万円～4,700万円"), { min: 4360, max: 4700, undecided: false, tentative: false });
  assert.deepEqual(parsePriceRangeMan("3720万円・3930万円"), { min: 3720, max: 3930, undecided: false, tentative: false });
  assert.deepEqual(parsePriceRangeMan("9880万円"), { min: 9880, max: 9880, undecided: false, tentative: false });
  assert.deepEqual(parsePriceRangeMan("3800万円台・5500万円台／予定"), { min: 3800, max: 5500, undecided: false, tentative: true });
  assert.deepEqual(parsePriceRangeMan("3699万円～5259万円／予定"), { min: 3699, max: 5259, undecided: false, tentative: true });
  assert.deepEqual(parsePriceRangeMan("価格未定"), { min: null, max: null, undecided: true, tentative: false });
  assert.deepEqual(parsePriceRangeMan("3億3000万円"), { min: 33000, max: 33000, undecided: false, tentative: false });
});

test("面積の幅・引渡時期・交通", () => {
  assert.deepEqual(parseAreaRange("45.59m<sup>2</sup>～111.59m<sup>2</sup>"), { min: 45.59, max: 111.59 });
  assert.deepEqual(parseAreaRange("65.19m2・110.21m2"), { min: 65.19, max: 110.21 });
  assert.deepEqual(parseAreaRange("43.76m2（13.23坪）（壁芯）"), { min: 43.76, max: 43.76 }, "坪は拾わない");
  assert.deepEqual(parseAreaRange("-"), { min: null, max: null });
  assert.deepEqual(parseDelivery("2028年7月下旬予定"), { ym: "2028-07", immediate: false });
  assert.deepEqual(parseDelivery("2026年9月"), { ym: "2026-09", immediate: false });
  assert.deepEqual(parseDelivery("即引渡可"), { ym: null, immediate: true });
  assert.deepEqual(parseDelivery("相談"), { ym: null, immediate: false });
  assert.deepEqual(parseShinchikuStation("西鉄天神大牟田線/西鉄平尾 徒歩5分"), { line: "西鉄天神大牟田線", station: "西鉄平尾", walk: 5, bus: false });
  assert.deepEqual(parseShinchikuStation("ＪＲ鹿児島本線/福工大前 徒歩14分"), { line: "JR鹿児島本線", station: "福工大前", walk: 14, bus: false });
  assert.deepEqual(parseShinchikuStation("西鉄バス/横手一丁目 徒歩3分"), { line: "西鉄バス", station: "横手一丁目", walk: null, bus: true });
  assert.deepEqual(parseShinchikuStation("ＪＲ鹿児島本線「二日市」徒歩7分"), { line: "JR鹿児島本線", station: "二日市", walk: 7, bus: false });
});

test("URL・リダイレクト（新築は /ms/shinchiku/ の中なら止めない）", () => {
  assert.equal(shinchikuSearchUrl("kasuga", 1), "https://suumo.jp/ms/shinchiku/fukuoka/sc_kasuga/");
  assert.equal(shinchikuSearchUrl("kasuga", 2), "https://suumo.jp/ms/shinchiku/fukuoka/sc_kasuga/?page=2");
  const src = new ShinchikuSource();
  const url = "https://suumo.jp/ms/shinchiku/fukuoka/sc_kasuga/?page=2";
  assert.equal(src.detectBlock(301, "", { url, location: "/ms/shinchiku/fukuoka/sc_kasuga/" }), null);
  assert.equal(src.detectBlock(301, "", { url, location: "/ms/chuko/fukuoka/sc_kasuga/" }), "redirect_challenge");
  assert.equal(src.detectBlock(429, "", { url, location: null }), "http_429");
  assert.equal(src.detectBlock(200, "<html>maintenance</html>"), "unexpected_structure");
});

test("架空ページ: 2 ページ・0 件ページの「近い物件」は読まない・解析結果が取り込み要求として通る", () => {
  const p1 = parseShinchikuListPage(renderFakeShinchikuPage("fukuokashihakata", 1, 1).html, "40132");
  assert.equal(p1.totalHits, 35);
  assert.equal(p1.maxPageLinked, 2, "ページャ以外の page=1 リンクに引きずられない");
  assert.equal(p1.listings.length, 30);
  const p2 = parseShinchikuListPage(renderFakeShinchikuPage("fukuokashihakata", 2, 1).html, "40132");
  assert.equal(p2.listings.length, 5);
  assert.ok(p1.listings.every((l) => l.municipalityCode === "40132"));
  assert.ok(p1.listings.some((l) => l.listingType === "unit"));
  const undecided = p1.listings.map(toNewListingRecord).find((r) => r.priceMin === undefined);
  assert.ok(undecided, "価格未定が混ざる");
  assert.equal(undecided.priceUndecided, true);
  assert.equal(undecided.saleStatus, "final", "価格未定でも「（最終期）」の表記があれば販売状況はそちら");

  // 0 件（中央区 = idx 2）。実物と同じく他の市区町村の物件が並ぶが、読まない
  const zero = renderFakeShinchikuPage("fukuokashichuo", 1, 1);
  assert.match(zero.html, /property_unit/);
  const z = parseShinchikuListPage(zero.html, "40133");
  assert.equal(z.zeroHits, true);
  assert.equal(z.listings.length, 0);
  assert.equal(detectBlock(200, zero.html, undefined, "/ms/shinchiku/"), null);

  const src = new ShinchikuSource({ origin: "http://127.0.0.1:8790" });
  const t = { areaCode: "40132", key: "fukuokashihakata" };
  const url = src.pageUrl(t, 1);
  const page = renderFakeShinchikuPage("fukuokashihakata", 1, 1);
  const o = classifyResponse(src, t, 1, url, page.status, page.html, null);
  assert.equal(o.kind, "parsed");
  const req = parseIngestRequest(
    JSON.parse(
      JSON.stringify({ op: "page", kind: "shinchiku", runId: "suumo:ms-shinchiku:2026-09-27", areaCode: "40132", page: 1, url, fetchedAt: new Date().toISOString(), outcome: o }),
    ),
  );
  assert.equal(req.op, "page");
  if (req.op === "page") {
    assert.equal(req.kind, "shinchiku");
    assert.deepEqual(req.outcome, o);
  }
  // 新築の結果を中古として送っても通らない（kind が違えば検証も違う）
  assert.throws(() =>
    parseIngestRequest(JSON.parse(JSON.stringify({ op: "page", runId: "suumo:ms-chuko:2026-09-27", areaCode: "40132", page: 1, url, fetchedAt: new Date().toISOString(), outcome: o }))),
  );
});

test("取り込み要求の検証（新築の 1 件）", () => {
  const base = {
    op: "page",
    kind: "shinchiku",
    runId: "suumo:ms-shinchiku:2026-09-27",
    areaCode: "40218",
    page: 1,
    url: "https://suumo.jp/ms/shinchiku/fukuoka/sc_kasuga/",
    fetchedAt: "2026-09-26T21:00:00.000Z",
  };
  const rec = (patch: Record<string, unknown>) => ({
    ...base,
    outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: 1, skipped: 0, records: [{ externalId: "67733732", listingType: "project", ...patch }] } },
  });
  assert.equal(parseIngestRequest(rec({ priceMin: 43_600_000, priceMax: 47_000_000, deliveryYm: "2027-03" })).op, "page");
  assert.equal(parseIngestRequest(rec({ priceUndecided: true })).op, "page", "価格未定（価格なし）も通る");
  assert.throws(() => parseIngestRequest(rec({ listingType: "land" })));
  assert.throws(() => parseIngestRequest(rec({ priceMin: 5, priceMax: 4 })));
  assert.throws(() => parseIngestRequest(rec({ priceMin: -1 })));
  assert.throws(() => parseIngestRequest(rec({ deliveryYm: "来年" })));
  assert.throws(() => parseIngestRequest(rec({ saleStatus: "sold'; --" })));
  assert.throws(() => parseIngestRequest(rec({ bus: "yes" })));
});

test("実データ: 中央区（26 件・物件 16 + 住戸 10）", { skip: !existsSync(join(PROBE, "chuo_p1.html")) }, () => {
  const html = readFileSync(join(PROBE, "chuo_p1.html"), "utf8");
  assert.equal(detectBlock(200, html, undefined, "/ms/shinchiku/"), null);
  assert.ok(html.includes('name="sc" value="40133"'));
  const p = parseShinchikuListPage(html, "40133");
  assert.equal(p.totalHits, 26);
  assert.equal(p.maxPageLinked, 1);
  assert.equal(p.listings.length, 26);
  const recs = p.listings.map(toNewListingRecord);
  assert.equal(recs.filter((r) => r.listingType === "unit").length, 10);
  for (const r of recs) {
    assert.equal(r.wardCode, "40133", `${r.externalId} ${r.address}`);
    assert.ok(r.stationName, `${r.externalId} 駅`);
    assert.ok(r.walkMinutes !== undefined || r.bus, `${r.externalId} 徒歩`);
    assert.ok(r.areaMin && r.areaMin > 20, `${r.externalId} 面積`);
    assert.ok(r.deliveryText, `${r.externalId} 引渡`);
    if (r.priceMin !== undefined) assert.ok(r.unitPriceMin && r.unitPriceMin > 300_000 && r.unitPriceMin < 5_000_000, `${r.externalId} ㎡単価 ${r.unitPriceMin}`);
  }
  assert.equal(recs.filter((r) => r.priceMin === undefined).length, 2, "価格未定 2 件");
  const mid = recs.find((r) => r.externalId === "67730531")!;
  assert.equal(mid.priceMin, 65_900_000);
  assert.equal(mid.priceMax, 121_900_000);
  assert.equal(mid.saleStatus, "first_come");
  assert.equal(mid.deliveryYm, "2027-09");
});

test("実データ: 春日市（近郊・予定価格）・宗像市（0 件＋近い物件）・10 件表示の 2 ページ目", { skip: !existsSync(join(PROBE, "kasuga_p1.html")) }, () => {
  const k = parseShinchikuListPage(readFileSync(join(PROBE, "kasuga_p1.html"), "utf8"), "40218");
  assert.equal(k.totalHits, 6);
  assert.equal(k.listings.length, 6);
  const recs = k.listings.map(toNewListingRecord);
  assert.ok(recs.every((r) => r.wardCode === "40218"));
  const gp = recs.find((r) => r.externalId === "67733624")!;
  assert.equal(gp.priceMin, 38_000_000);
  assert.equal(gp.priceMax, 65_980_000);
  assert.equal(gp.priceTentative, true);

  const m = readFileSync(join(PROBE, "munakata_p1.html"), "utf8");
  assert.ok(m.includes('name="sc" value="40220"'));
  const z = parseShinchikuListPage(m, "40220");
  assert.equal(z.zeroHits, true);
  assert.equal(z.listings.length, 0, "他の市区町村の「近い物件」を宗像市として読まない");

  const p2 = parseShinchikuListPage(readFileSync(join(PROBE, "chuo_pc10_p2.html"), "utf8"), "40133");
  assert.equal(p2.totalHits, 26);
  assert.equal(p2.maxPageLinked, 3);
  assert.equal(p2.listings.length, 10);
});

test("実データ: 新築の市区町村一覧のスラッグは中古の台帳と同じ", { skip: !existsSync(join(PROBE, "city.html")) }, () => {
  const html = readFileSync(join(PROBE, "city.html"), "utf8");
  const slugs = new Set([...html.matchAll(/href="\/ms\/shinchiku\/fukuoka\/sc_([a-z]+)\/"/g)].map((m) => m[1]));
  const ours = new Set(Object.values(SUUMO_SLUGS));
  // 一覧に出るのは掲載のある市区町村だけ。出ているもののうち対象（台帳）に入るものは、台帳のスラッグと一致する
  for (const s of ["fukuokashihigashi", "fukuokashichuo", "kasuga", "onojo", "kasuyagunshingu", "nakagawa"]) {
    assert.ok(slugs.has(s), s);
    assert.ok(ours.has(s), s);
  }
});

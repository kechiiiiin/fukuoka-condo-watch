// 賃貸（/chintai/）のパーサと正規化・取り込み要求・kind 一般化のテスト。
// ⚠️ 実ページ由来のサンプルは無い（賃貸の追加時に本番 SUUMO へは一切アクセスしていない）。
//    ここで使うのは scripts/fake-suumo-server.ts の生成 HTML（src/suumo-chintai.ts 冒頭に書いた構造に合わせたもの）。
//    実ページのクラス名・件数表示・ペット表記の位置は初回のクロールで確かめること（README「賃貸」）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChintaiBuildings, renderFakeChintaiPage } from "../scripts/fake-suumo-server.ts";
import { classifyResponse, CRAWL_KINDS, listingKindOf, parseCrawlKind, parseIngestRequest } from "../src/listing-crawl-core.ts";
import { SUUMO_SLUGS } from "../src/suumo.ts";
import {
  CHINTAI_QUERY,
  CHINTAI_SOURCE_ID,
  ChintaiSource,
  chintaiSearchUrl,
  hasChintaiListStructure,
  parseBuildingAge,
  parseChintaiListPage,
  parseChintaiStation,
  parseDepositYen,
  parseFeeYen,
  parseListedOn,
  parsePetsAllowed,
  parseYen,
  toRentListingRecord,
} from "../src/suumo-chintai.ts";

test("賃料・管理費の表記 → 円", () => {
  assert.equal(parseYen("7.3万円"), 73000);
  assert.equal(parseYen("12万円"), 120000);
  assert.equal(parseYen("１０．５万円"), 105000);
  assert.equal(parseYen("150,000円"), 150000);
  assert.equal(parseYen("-"), null);
  // 管理費・共益費: 「-」「なし」は 0（読めないの null と区別する）
  assert.equal(parseFeeYen("5000円"), 5000);
  assert.equal(parseFeeYen("-"), 0);
  assert.equal(parseFeeYen("なし"), 0);
  assert.equal(parseFeeYen("1万円"), 10000);
  assert.equal(parseFeeYen(""), null);
});

test("敷金・礼金（月数表記は賃料 × 月数で円に直す）", () => {
  assert.equal(parseDepositYen("7.3万円", 73000), 73000);
  assert.equal(parseDepositYen("1ヶ月", 73000), 73000);
  assert.equal(parseDepositYen("2ヶ月", 73000), 146000);
  assert.equal(parseDepositYen("2.5ヶ月", 80000), 200000);
  assert.equal(parseDepositYen("なし", 73000), 0);
  assert.equal(parseDepositYen("-", 73000), 0);
  // 賃料が分からないのに月数表記なら推測で埋めない
  assert.equal(parseDepositYen("1ヶ月", null), null);
  assert.equal(parseDepositYen("", 73000), null);
});

test("ペット相談可（不可は false）", () => {
  assert.equal(parsePetsAllowed("ペット相談"), true);
  assert.equal(parsePetsAllowed("ペット相談可"), true);
  assert.equal(parsePetsAllowed("小型犬可・ペット飼育可"), true);
  assert.equal(parsePetsAllowed("<span>ペット可</span>"), true);
  assert.equal(parsePetsAllowed("ペット不可"), false);
  assert.equal(parsePetsAllowed("ペット相談不可"), false);
  assert.equal(parsePetsAllowed("ペット 飼育 不可"), false);
  assert.equal(parsePetsAllowed("駐車場あり"), false);
});

test("築年数・交通・情報公開日", () => {
  assert.equal(parseBuildingAge("築15年"), 15);
  assert.equal(parseBuildingAge("新築"), 0);
  assert.equal(parseBuildingAge("9階建"), null);
  assert.deepEqual(parseChintaiStation("西鉄天神大牟田線/薬院駅 歩5分"), { line: "西鉄天神大牟田線", station: "薬院", walk: 5, bus: false });
  assert.deepEqual(parseChintaiStation("ＪＲ鹿児島本線/博多駅 徒歩12分"), { line: "JR鹿児島本線", station: "博多", walk: 12, bus: false });
  const bus = parseChintaiStation("西鉄バス/テスト前 バス8分 停歩2分");
  assert.equal(bus.bus, true);
  assert.equal(bus.walk, null, "バス便の徒歩分を駅距離と取り違えない");
  assert.equal(parseListedOn("情報公開日：2026/9/20"), "2026-09-20");
  assert.equal(parseListedOn("2026年10月1日"), "2026-10-01");
  assert.equal(parseListedOn("新着"), null);
});

test("検索 URL は絞り込みクエリ付き・sort は付けない（robots.txt）", () => {
  const u = chintaiSearchUrl("fukuokashichuo", 1);
  assert.ok(u.startsWith("https://suumo.jp/chintai/fukuoka/sc_fukuokashichuo/?"));
  assert.ok(!/sort=/.test(u), "並べ替えパラメータは robots.txt で Disallow");
  assert.ok(u.includes("ct=20.0"));
  assert.ok(u.includes("md=10"));
  assert.ok(chintaiSearchUrl("kasuga", 3).endsWith("&page=3"));
  assert.equal(CHINTAI_QUERY.filter(([k]) => k === "md").length, 7, "3K〜5K以上の 7 つ");
  // 対象は中古・新築と同じ 23 市区町村（SUUMO_SLUGS）
  assert.equal(new ChintaiSource().targets().length, Object.values(SUUMO_SLUGS).filter(Boolean).length);
});

test("一覧 1 ページの解析（建物 → 部屋・賃料・管理費・敷礼・ペット・掲載日）", () => {
  const page = renderFakeChintaiPage("fukuokashichuo", 1, 1);
  assert.equal(page.status, 200);
  const p = parseChintaiListPage(page.html, "40133", 2026);
  assert.equal(p.zeroHits, false);
  const expected = fakeChintaiBuildings("fukuokashichuo", 1);
  assert.equal(p.buildings.length, expected.length);
  assert.equal(p.totalHits, expected.reduce((n, b) => n + b.rooms.length, 0), "件数表示は部屋数");

  const b = p.buildings[0]!;
  assert.equal(b.buildingName, expected[0]!.name);
  assert.equal(b.municipalityCode, "40133");
  assert.equal(b.lineName, "JR鹿児島本線");
  assert.equal(b.stationName, "テスト");
  assert.equal(b.walkMinutes, expected[0]!.walk);
  assert.equal(b.bus, false, "最初の交通が徒歩ならバス便にしない");
  assert.equal(b.buildingAge, expected[0]!.age);
  assert.equal(b.buildingYear, 2026 - expected[0]!.age);
  assert.equal(b.petsAllowed, expected[0]!.pets);

  const room = b.rooms[0]!;
  const er = expected[0]!.rooms[0]!;
  assert.equal(room.externalId, `jnc_${er.id}`);
  assert.equal(room.url, `https://suumo.jp/chintai/jnc_${er.id}/`, "クエリは落とす");
  assert.equal(room.rentYen, Math.round(er.rentMan * 10000));
  assert.equal(room.adminFeeYen, er.adminYen);
  assert.equal(room.depositYen, Math.round(er.rentMan * 10000), "敷金 1ヶ月 = 賃料");
  assert.equal(room.keyMoneyYen, 0, "礼金なし = 0");
  assert.equal(room.floorPlan, er.madori);
  assert.equal(room.areaSqm, er.area);
  assert.equal(room.listedOn, "2026-09-" + String(1 + ((2 + 0) % 25)).padStart(2, "0"));
  // 部屋数の合計が全部 record になる（賃料が読めない部屋は skipped）
  const parsed = new ChintaiSource().parsePage(page.html, { areaCode: "40133", key: "fukuokashichuo" });
  assert.equal(parsed.records.length, p.totalHits);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.records.every((r) => r.kind === "rent"), true);
});

test("0 件ページ・ページ切れ・構造判定", () => {
  const zero = renderFakeChintaiPage("kasuyagunhisayama", 1, 1);
  const p = parseChintaiListPage(zero.html, "40348");
  assert.equal(p.zeroHits, true);
  assert.equal(p.buildings.length, 0);
  assert.equal(hasChintaiListStructure(zero.html), true, "0 件ページも一覧の構造として扱う（構造変更と誤判定しない）");
  assert.equal(hasChintaiListStructure("<html><body>maintenance</body></html>"), false);
  assert.equal(renderFakeChintaiPage("fukuokashichuo", 9, 1).status, 404);
});

test("取り込み要求: chintai は rent だけ通す・chuko は sale だけ（kind 一般化の回帰）", () => {
  assert.equal(parseCrawlKind("chintai"), "chintai");
  assert.equal(listingKindOf("chuko"), "sale");
  assert.equal(listingKindOf("chintai"), "rent");
  assert.equal(listingKindOf("shinchiku"), null, "新築は new_listings なので listings の kind を持たない");
  assert.equal(CRAWL_KINDS.chintai.sourceId, CHINTAI_SOURCE_ID);

  const page = renderFakeChintaiPage("kasuga", 1, 1);
  const src = new ChintaiSource({ origin: "http://127.0.0.1:8790" });
  const t = { areaCode: "40218", key: "kasuga" };
  const url = src.pageUrl(t, 1);
  const o = classifyResponse(src, t, 1, url, 200, page.html, null);
  assert.equal(o.kind, "parsed");
  // 解析結果はそのまま取り込み要求として通る（Mac → Worker の往復で形が崩れない）
  const req = parseIngestRequest(
    JSON.parse(
      JSON.stringify({
        op: "page", kind: "chintai", runId: `${CHINTAI_SOURCE_ID}:2026-09-26`, areaCode: "40218", page: 1, url,
        fetchedAt: new Date().toISOString(), outcome: o,
      }),
    ),
  );
  assert.equal(req.op, "page");
  if (req.op === "page") {
    assert.equal(req.kind, "chintai");
    assert.deepEqual(req.outcome, o);
  }

  const rentRec = { externalId: "jnc_000012345678", kind: "rent", price: 95000, adminFee: 5000, deposit: 95000, keyMoney: 0, petsAllowed: true, listedOn: "2026-09-20" };
  const saleRec = { externalId: "21637649", kind: "sale", price: 27900000 };
  const reqFor = (kind: string, runSource: string, rec: unknown) => ({
    op: "page", kind, runId: `${runSource}:2026-09-26`, areaCode: "40218", page: 1,
    url: "https://suumo.jp/chintai/fukuoka/sc_kasuga/", fetchedAt: "2026-09-26T00:00:00.000Z",
    outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: null, skipped: 0, records: [rec] } },
  });
  assert.equal(parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, rentRec)).op, "page");
  assert.equal(parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", saleRec)).op, "page");
  // 取得元ごとに許す kind の外は弾く
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, saleRec)), /kind が不正/);
  assert.throws(() => parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", rentRec)), /kind が不正/);
  // 賃貸だけの項目は売買の要求に混ぜられない
  assert.throws(() => parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", { ...saleRec, petsAllowed: true })), /賃貸だけの項目/);
  // 値の形も見る
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, { ...rentRec, listedOn: "2026/09/20" })), /listedOn が不正/);
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, { ...rentRec, adminFee: -1 })), /adminFee が不正/);
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, { ...rentRec, petsAllowed: "yes" })), /petsAllowed が不正/);
  // kind と runId の取得元が食い違う要求は受けない
  assert.throws(() => parseIngestRequest(reqFor("chintai", "suumo:ms-chuko", rentRec)));
});

test("1 部屋 → ListingRecord（賃料が読めない部屋は捨てる）", () => {
  const b = parseChintaiListPage(renderFakeChintaiPage("onojo", 1, 1).html, "40219", 2026).buildings[0]!;
  const r = toRentListingRecord(b, b.rooms[0]!)!;
  assert.equal(r.kind, "rent");
  assert.equal(r.price, b.rooms[0]!.rentYen);
  assert.equal(r.wardCode, "40219");
  assert.equal(r.buildingYear, b.buildingYear);
  assert.equal(r.petsAllowed, b.rooms[0]!.petsAllowed);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: null }), null);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: 0 }), null);
});

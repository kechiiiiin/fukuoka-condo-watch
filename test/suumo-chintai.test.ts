// 賃貸（/chintai/）のパーサと正規化・取り込み要求・kind 一般化のテスト。
// - 実ページ由来: ~/work/_experiments/listing-probe/chintai/（2026-09-26 取得の chuo_p1・chuo_p1_pets・chuo_p2・
//   kasuga_p1・hisayama_p1・zerohits）。**リポジトリには入れない**（SUUMO のコンテンツを public リポジトリで再配布しないため）。
//   無ければ skip。LISTING_PROBE_DIR で場所を変えられる
// - 架空: scripts/fake-suumo-server.ts の生成 HTML（実ページの構造に合わせてある。常に走る）
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeChintaiBuildings, renderFakeChintaiPage } from "../scripts/fake-suumo-server.ts";
import { classifyResponse, CRAWL_KINDS, listingKindOf, parseCrawlKind, parseIngestRequest } from "../src/listing-crawl-core.ts";
import { SUUMO_SLUGS } from "../src/suumo.ts";
import {
  CHINTAI_PETS_PARAM,
  CHINTAI_PETS_SOURCE_ID,
  CHINTAI_QUERY,
  CHINTAI_SOURCE_ID,
  ChintaiSource,
  chintaiSearchUrl,
  hasChintaiListStructure,
  parseBuildingAge,
  parseBuildingFloors,
  parseChintaiListPage,
  parseChintaiStation,
  parseDepositYen,
  parseFeeYen,
  parseYen,
  toRentListingRecord,
} from "../src/suumo-chintai.ts";

const PROBE = join(process.env.LISTING_PROBE_DIR ?? join(homedir(), "work/_experiments/listing-probe"), "chintai");
const probe = (name: string) => readFileSync(join(PROBE, `${name}.html`), "utf8");
const hasProbe = (name: string) => existsSync(join(PROBE, `${name}.html`));

test("賃料・管理費の表記 → 円（'-' は不明・NULL）", () => {
  assert.equal(parseYen("16万円"), 160000);
  assert.equal(parseYen("7.3万円"), 73000);
  assert.equal(parseYen("１０．５万円"), 105000);
  assert.equal(parseYen("150,000円"), 150000);
  assert.equal(parseYen("-"), null);
  assert.equal(parseFeeYen("9000円"), 9000);
  assert.equal(parseFeeYen("1万円"), 10000);
  // ⚠️ 実ページで管理費が "-" の部屋は多いが、「0 円」か「表記なし」かは一覧からは決められないので不明（null）にする
  assert.equal(parseFeeYen("-"), null);
  assert.equal(parseFeeYen("なし"), 0, "「なし」と書いてあるときだけ 0");
  assert.equal(parseFeeYen(""), null);
});

test("敷金・礼金（円建てが主・月数表記も受ける・'-' は不明）", () => {
  assert.equal(parseDepositYen("16万円", 160000), 160000);
  assert.equal(parseDepositYen("32万円", 160000), 320000);
  assert.equal(parseDepositYen("8.5万円", 85000), 85000);
  assert.equal(parseDepositYen("-", 160000), null, "'-' は 0 と決めつけない");
  assert.equal(parseDepositYen("なし", 160000), 0);
  assert.equal(parseDepositYen("1ヶ月", 73000), 73000);
  assert.equal(parseDepositYen("2.5ヶ月", 80000), 200000);
  assert.equal(parseDepositYen("1ヶ月", null), null, "賃料が分からないのに月数表記なら推測で埋めない");
});

test("築年数・建物階数・交通", () => {
  assert.equal(parseBuildingAge("築26年 8階建"), 26);
  assert.equal(parseBuildingAge("新築 10階建"), 0);
  assert.equal(parseBuildingAge("8階建"), null);
  assert.equal(parseBuildingFloors("築26年 8階建"), 8);
  assert.equal(parseBuildingFloors("地下1地上14階建"), 14);
  assert.deepEqual(parseChintaiStation("地下鉄空港線/唐人町駅 歩8分"), { line: "地下鉄空港線", station: "唐人町", walk: 8, bus: false });
  assert.deepEqual(parseChintaiStation("ＪＲ鹿児島本線/博多駅 徒歩12分"), { line: "JR鹿児島本線", station: "博多", walk: 12, bus: false });
  const bus = parseChintaiStation("西鉄バス/みずほPayPayドーム 歩2分");
  assert.equal(bus.bus, true);
  assert.equal(bus.walk, null, "バス便の徒歩分を駅距離と取り違えない");
});

test("検索 URL は絞り込みクエリ付き・sort は付けない・ペットは tc=0401102", () => {
  const u = chintaiSearchUrl("fukuokashichuo", 1);
  assert.ok(u.startsWith("https://suumo.jp/chintai/fukuoka/sc_fukuokashichuo/?"));
  assert.ok(!/sort=/.test(u), "並べ替えパラメータは robots.txt で Disallow");
  assert.ok(u.includes("ct=20.0") && u.includes("mb=60") && u.includes("md=10"));
  assert.ok(!u.includes("tc="), "1 周目はペット絞り込みを付けない");
  assert.ok(chintaiSearchUrl("kasuga", 3).endsWith("&page=3"));
  const pets = chintaiSearchUrl("fukuokashichuo", 1, undefined, true);
  assert.ok(pets.includes(`${CHINTAI_PETS_PARAM[0]}=${CHINTAI_PETS_PARAM[1]}`));
  assert.equal(CHINTAI_QUERY.filter(([k]) => k === "md").length, 7, "3K〜5K以上の 7 つ");
  // 対象は中古・新築と同じ 23 市区町村（SUUMO_SLUGS）。2 周目も同じ
  assert.equal(new ChintaiSource().targets().length, Object.values(SUUMO_SLUGS).filter(Boolean).length);
  assert.deepEqual(new ChintaiSource({ pets: true }).targets(), new ChintaiSource().targets());
  assert.equal(new ChintaiSource().id, CHINTAI_SOURCE_ID);
  assert.equal(new ChintaiSource({ pets: true }).id, CHINTAI_PETS_SOURCE_ID);
  assert.equal(new ChintaiSource().pageCountFromLinks, true, "件数からページ数を出せないのでページャを正にする");
});

test("架空ページ: 建物→部屋・ページャ・ペット絞り込みの 2 周目", () => {
  const p1 = renderFakeChintaiPage("fukuokashichuo", 1, 1);
  assert.equal(p1.status, 200);
  const p = parseChintaiListPage(p1.html, "40133", 2026);
  assert.equal(p.zeroHits, false);
  assert.ok(p.buildings.length > 0);
  assert.equal(p.maxPageLinked, 2, "ページャの最終番号");
  // ⚠️ 件数表示は掲載の数で、一覧の行数とは一致しない（実ページと同じ性質）
  assert.ok((p.totalHits ?? 0) > p.buildings.flatMap((b) => b.rooms).length);

  const b = p.buildings[0]!;
  assert.equal(b.buildingName, "架空ハイツ2-0");
  assert.equal(b.municipalityCode, "40133");
  assert.equal(b.lineName, "JR鹿児島本線");
  assert.equal(b.stationName, "テスト", "駅名末尾の「駅」は落とす");
  assert.equal(b.bus, false, "最初の交通が徒歩ならバス便にしない");
  assert.equal(b.buildingYear, 2026 - b.buildingAge!);
  assert.equal(b.buildingFloors, 5);

  const room = b.rooms[0]!;
  assert.match(room.externalId, /^\d{12}$/, "部屋の ID は js-clipkey の 12 桁（jnc_ は掲載の ID）");
  assert.ok(room.url.startsWith("https://suumo.jp/chintai/jnc_"));
  assert.ok(room.url.includes(`?bc=${room.externalId}`), "リンクは部屋を指す bc 付き");
  assert.equal(room.rentYen, 90000);
  assert.equal(room.floorPlan, "3LDK");
  assert.equal(room.areaSqm, 70.5, "m<sup>2</sup> を剥がして読む");
  assert.equal(room.floorText, "2階");

  // 2 周目（ペット絞り込み）は同じ形の一覧で、出た部屋にだけ petsAllowed が立つ
  const pets = renderFakeChintaiPage("fukuokashichuo", 1, 1, true);
  const petsRecs = new ChintaiSource({ pets: true }).parsePage(pets.html, { areaCode: "40133", key: "fukuokashichuo" });
  assert.ok(petsRecs.records.length > 0);
  assert.equal(petsRecs.records.every((r) => r.petsAllowed === true), true);
  const plain = new ChintaiSource().parsePage(p1.html, { areaCode: "40133", key: "fukuokashichuo" });
  assert.equal(plain.records.every((r) => r.petsAllowed === undefined), true, "1 周目はペット可否を立てない（NULL = 不明）");
  assert.equal(plain.skipped, 0);
});

test("架空ページ: 0 件・ページ切れ・構造判定", () => {
  // 久山町はペット相談可の部屋が無い → 2 周目は 0 件ページ
  const zero = renderFakeChintaiPage("kasuyagunhisayama", 1, 1, true);
  const p = parseChintaiListPage(zero.html, "40348");
  assert.equal(p.zeroHits, true);
  assert.equal(p.buildings.length, 0);
  assert.equal(hasChintaiListStructure(zero.html), true, "0 件ページも一覧の構造として扱う（構造変更と誤判定しない）");
  assert.equal(hasChintaiListStructure("<html><body>maintenance</body></html>"), false);
  assert.equal(renderFakeChintaiPage("fukuokashichuo", 9, 1).status, 404);
  assert.ok(fakeChintaiBuildings("kasuyagunhisayama", 1).length > 0, "1 周目は物件がある");
});

test("取り込み要求: chintai / chintai_pets は rent だけ通す・chuko は sale だけ（kind 一般化の回帰）", () => {
  assert.equal(parseCrawlKind("chintai"), "chintai");
  assert.equal(parseCrawlKind("chintai_pets"), "chintai_pets");
  assert.equal(listingKindOf("chuko"), "sale");
  assert.equal(listingKindOf("chintai"), "rent");
  assert.equal(listingKindOf("chintai_pets"), "rent");
  assert.equal(listingKindOf("shinchiku"), null, "新築は new_listings なので listings の kind を持たない");
  assert.equal(CRAWL_KINDS.chintai.sourceId, CHINTAI_SOURCE_ID);
  assert.equal(CRAWL_KINDS.chintai_pets.sourceId, CHINTAI_PETS_SOURCE_ID);

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

  const rentRec = { externalId: "100437646092", kind: "rent", price: 160000, adminFee: 9000, deposit: 160000, keyMoney: 320000, petsAllowed: true };
  const saleRec = { externalId: "21637649", kind: "sale", price: 27900000 };
  const reqFor = (kind: string, runSource: string, rec: unknown) => ({
    op: "page", kind, runId: `${runSource}:2026-09-26`, areaCode: "40218", page: 1,
    url: "https://suumo.jp/chintai/fukuoka/sc_kasuga/", fetchedAt: "2026-09-26T00:00:00.000Z",
    outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: null, skipped: 0, records: [rec] } },
  });
  assert.equal(parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, rentRec)).op, "page");
  assert.equal(parseIngestRequest(reqFor("chintai_pets", CHINTAI_PETS_SOURCE_ID, rentRec)).op, "page");
  assert.equal(parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", saleRec)).op, "page");
  // 取得元ごとに許す kind の外は弾く
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, saleRec)), /kind が不正/);
  assert.throws(() => parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", rentRec)), /kind が不正/);
  // 賃貸だけの項目は売買の要求に混ぜられない
  assert.throws(() => parseIngestRequest(reqFor("chuko", "suumo:ms-chuko", { ...saleRec, petsAllowed: true })), /賃貸だけの項目/);
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, { ...rentRec, adminFee: -1 })), /adminFee が不正/);
  assert.throws(() => parseIngestRequest(reqFor("chintai", CHINTAI_SOURCE_ID, { ...rentRec, petsAllowed: "yes" })), /petsAllowed が不正/);
  // kind と runId の取得元が食い違う要求は受けない
  assert.throws(() => parseIngestRequest(reqFor("chintai", "suumo:ms-chuko", rentRec)));
  assert.throws(() => parseIngestRequest(reqFor("chintai_pets", CHINTAI_SOURCE_ID, rentRec)));
});

test("1 部屋 → ListingRecord（賃料が読めない部屋は捨てる・掲載日は入れない）", () => {
  const b = parseChintaiListPage(renderFakeChintaiPage("onojo", 1, 1).html, "40219", 2026).buildings[0]!;
  const r = toRentListingRecord(b, b.rooms[0]!)!;
  assert.equal(r.kind, "rent");
  assert.equal(r.price, b.rooms[0]!.rentYen);
  assert.equal(r.wardCode, "40219");
  assert.equal(r.buildingYear, b.buildingYear);
  assert.equal(r.petsAllowed, undefined, "1 周目はペット可否が分からない");
  assert.equal(r.listedOn, undefined, "掲載日・情報公開日は一覧に無い（賃貸では常に NULL）");
  assert.equal(toRentListingRecord(b, b.rooms[0]!, true)!.petsAllowed, true);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: null }), null);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: 0 }), null);
});

// ---------------------------------------------------------------- 実データ（無ければ skip）

test("実データ: 福岡市中央区 1 ページ目（2026-09-26）", { skip: !hasProbe("chuo_p1") && "listing-probe/chintai が無い" }, () => {
  const p = parseChintaiListPage(probe("chuo_p1"), "40133", 2026);
  assert.equal(p.totalHits, 734, "件数表示（掲載の数）");
  assert.equal(p.maxPageLinked, 8, "ページャの最終ページ");
  assert.equal(p.buildings.length, 20, "1 ページ 20 建物");
  const rooms = p.buildings.flatMap((b) => b.rooms);
  assert.equal(rooms.length, 36);
  // ⚠️ 件数（734）÷ 1 ページ件数ではページ数が出ない（建物ごとにまとめて表示するため）。8 ページが正
  assert.ok(p.totalHits! / 20 > p.maxPageLinked!);

  // 全部の行から要る項目が取れている（取りこぼし 0）
  assert.equal(rooms.filter((r) => r.rentYen === null).length, 0, "賃料");
  assert.equal(rooms.filter((r) => r.areaSqm === null).length, 0, "専有面積");
  assert.equal(rooms.filter((r) => !r.floorPlan).length, 0, "間取り");
  assert.equal(rooms.filter((r) => !r.url).length, 0, "リンク");
  assert.equal(rooms.filter((r) => !/^\d{12}$/.test(r.externalId)).length, 0, "部屋 ID は 12 桁");
  assert.equal(p.buildings.filter((b) => b.buildingYear === null).length, 0, "築年");
  assert.equal(p.buildings.filter((b) => !b.address).length, 0, "所在地（col1）");
  assert.equal(p.buildings.filter((b) => !b.stationName).length, 0, "沿線・駅（col2 は子要素の中）");
  assert.equal(p.buildings.filter((b) => b.buildingFloors === null).length, 0, "階建（col3 は子要素の中）");
  assert.equal(p.buildings.filter((b) => b.municipalityCode !== "40133").length, 0, "住所 → 市区町村コード");

  const first = p.buildings[0]!;
  assert.equal(first.buildingName, "パークハウス地行浜アベニュー");
  assert.equal(first.address, "福岡県福岡市中央区地行４");
  assert.equal(first.lineName, "地下鉄空港線");
  assert.equal(first.stationName, "唐人町");
  assert.equal(first.walkMinutes, 8);
  assert.equal(first.buildingAge, 26);
  assert.equal(first.buildingFloors, 8);
  const r0 = first.rooms[0]!;
  assert.equal(r0.externalId, "100437646092");
  assert.equal(r0.url, "https://suumo.jp/chintai/jnc_000109723289/?bc=100437646092");
  assert.equal(r0.rentYen, 160000);
  assert.equal(r0.adminFeeYen, null, "管理費が '-' なら不明");
  assert.equal(r0.depositYen, 160000);
  assert.equal(r0.keyMoneyYen, 320000);
  assert.equal(r0.floorPlan, "3LDK");
  assert.equal(r0.areaSqm, 77);
  assert.equal(r0.floorText, "4階");

  // ペット可否・掲載日は一覧に無い（1 周目の記録には入らない）
  const recs = new ChintaiSource().parsePage(probe("chuo_p1"), { areaCode: "40133", key: "fukuokashichuo" });
  assert.equal(recs.records.length, 36);
  assert.equal(recs.skipped, 0);
  assert.equal(recs.records.filter((r) => r.petsAllowed !== undefined).length, 0);
  assert.equal(recs.records.filter((r) => r.listedOn !== undefined).length, 0);
});

test("実データ: 2 ページ目・近郊（春日市）・件数の少ない町（久山町）", { skip: !hasProbe("chuo_p2") && "listing-probe/chintai が無い" }, () => {
  const p2 = parseChintaiListPage(probe("chuo_p2"), "40133", 2026);
  assert.equal(p2.totalHits, 734);
  assert.equal(p2.maxPageLinked, 8, "2 ページ目でもページャに最終ページが出る");
  assert.equal(p2.buildings.length, 20);
  assert.equal(p2.buildings.flatMap((b) => b.rooms).length, 26, "1 ページの部屋数は一定ではない");

  const kasuga = parseChintaiListPage(probe("kasuga_p1"), "40218", 2026);
  assert.equal(kasuga.totalHits, 663);
  assert.equal(kasuga.maxPageLinked, 7);
  assert.equal(kasuga.buildings.filter((b) => b.municipalityCode !== "40218").length, 0, "近郊の住所も市区町村コードに落ちる");

  const hisayama = parseChintaiListPage(probe("hisayama_p1"), "40348", 2026);
  assert.equal(hisayama.totalHits, 17);
  assert.equal(hisayama.maxPageLinked, 1, "1 ページだけの市区町村");
  assert.equal(hisayama.zeroHits, false);
  assert.ok(hisayama.buildings.length > 0);
});

test("実データ: ペット絞り込みの 2 周目（tc=0401102）", { skip: !hasProbe("chuo_p1_pets") && "listing-probe/chintai が無い" }, () => {
  const pets = parseChintaiListPage(probe("chuo_p1_pets"), "40133", 2026);
  const plain = parseChintaiListPage(probe("chuo_p1"), "40133", 2026);
  assert.equal(pets.totalHits, 177, "ペット相談可だけに絞ると件数が減る（734 → 177）");
  assert.equal(pets.maxPageLinked, 2, "2 周目は 1 周目（8 ページ）より少ない");
  assert.ok(pets.totalHits! < plain.totalHits!);
  // 2 周目も同じ形の一覧。部屋 ID は 1 周目と同じ体系（重なりがある）
  const ids = new Set(plain.buildings.flatMap((b) => b.rooms).map((r) => r.externalId));
  const petIds = pets.buildings.flatMap((b) => b.rooms).map((r) => r.externalId);
  assert.ok(petIds.some((id) => ids.has(id)), "1 周目と同じ部屋 ID が出る（pets_allowed を立てる相手が居る）");

  const recs = new ChintaiSource({ pets: true }).parsePage(probe("chuo_p1_pets"), { areaCode: "40133", key: "fukuokashichuo" });
  assert.ok(recs.records.length > 0);
  assert.equal(recs.records.every((r) => r.petsAllowed === true), true);
});

test("実データ: 0 件ページ（条件にあう物件がありません）", { skip: !hasProbe("zerohits") && "listing-probe/chintai が無い" }, () => {
  const html = probe("zerohits");
  const p = parseChintaiListPage(html, "40348");
  assert.equal(p.zeroHits, true);
  assert.equal(p.totalHits, null, "0 件ページには件数表示が無い");
  assert.equal(p.buildings.length, 0);
  assert.equal(hasChintaiListStructure(html), true, "構造変更（unexpected_structure）と誤判定しない");
  assert.equal(new ChintaiSource().detectBlock(200, html), null, "止まるべき応答ではない");
});

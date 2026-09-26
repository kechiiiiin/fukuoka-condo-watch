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
import { fakeChintaiBuildings, renderFakeChintaiDetail, renderFakeChintaiPage } from "../scripts/fake-suumo-server.ts";
import {
  CHINTAI_DETAIL_MAX_PER_RUN,
  classifyResponse,
  CRAWL_KINDS,
  listingKindOf,
  listingUpsertRow,
  parseCrawlKind,
  parseIngestRequest,
} from "../src/listing-crawl-core.ts";
import { districtNameFromAddress } from "../src/listing-grouping.ts";
import { SUUMO_SLUGS } from "../src/suumo.ts";
import {
  CHINTAI_MAISONETTE_PATH,
  CHINTAI_MAISONETTE_SOURCE_ID,
  CHINTAI_PETS_PARAM,
  CHINTAI_PETS_SOURCE_ID,
  CHINTAI_QUERY,
  CHINTAI_SOURCE_ID,
  ChintaiSource,
  chintaiDetailUrl,
  chintaiSearchUrl,
  hasChintaiDetailStructure,
  hasChintaiListStructure,
  parseBuildingAge,
  parseBuildingFloors,
  parseChintaiDetailPage,
  parseChintaiListPage,
  parseChintaiStation,
  parseDepositYen,
  parseDetailFloors,
  parseFeeYen,
  parseLdkTatami,
  parseRoomFloor,
  parseYen,
  toRentListingRecord,
} from "../src/suumo-chintai.ts";

const PROBE = join(process.env.LISTING_PROBE_DIR ?? join(homedir(), "work/_experiments/listing-probe"), "chintai");
const probe = (name: string) => readFileSync(join(PROBE, `${name}.html`), "utf8");
const hasProbe = (name: string) => existsSync(join(PROBE, `${name}.html`));
/** 詳細ページの実データ（~/work/_experiments/listing-probe/chintai/detail/。無ければ skip） */
const detailProbe = (name: string) => readFileSync(join(PROBE, "detail", `${name}.html`), "utf8");
const hasDetailProbe = (name: string) => existsSync(join(PROBE, "detail", `${name}.html`));

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
  const pets = chintaiSearchUrl("fukuokashichuo", 1, undefined, "pets");
  assert.ok(pets.includes(`${CHINTAI_PETS_PARAM[0]}=${CHINTAI_PETS_PARAM[1]}`));
  assert.equal(CHINTAI_QUERY.filter(([k]) => k === "md").length, 7, "3K〜5K以上の 7 つ");
  // 対象は中古・新築と同じ 23 市区町村（SUUMO_SLUGS）。2 周目も同じ
  assert.equal(new ChintaiSource().targets().length, Object.values(SUUMO_SLUGS).filter(Boolean).length);
  assert.deepEqual(new ChintaiSource({ pets: true }).targets(), new ChintaiSource().targets());
  assert.equal(new ChintaiSource().id, CHINTAI_SOURCE_ID);
  assert.equal(new ChintaiSource({ pets: true }).id, CHINTAI_PETS_SOURCE_ID);
  assert.equal(new ChintaiSource().pageCountFromLinks, true, "件数からページ数を出せないのでページャを正にする");
});

test("部屋の階の表記 → 階数と室内 2 層（メゾネット）", () => {
  assert.deepEqual(parseRoomFloor("4階"), { floor: 4, multiLevel: false });
  assert.deepEqual(parseRoomFloor("14階"), { floor: 14, multiLevel: false });
  // 実ページに出る "1-2階" は住戸が 2 フロアにまたがっている = メゾネット。階は一番下を採る
  assert.deepEqual(parseRoomFloor("1-2階"), { floor: 1, multiLevel: true });
  assert.deepEqual(parseRoomFloor("２-３階"), { floor: 2, multiLevel: true }, "全角も読む");
  assert.deepEqual(parseRoomFloor("-"), { floor: null, multiLevel: false }, "'-' は不明");
  assert.deepEqual(parseRoomFloor(null), { floor: null, multiLevel: false });
  assert.deepEqual(parseRoomFloor("地下1階"), { floor: null, multiLevel: false }, "地下は地上の階数として使わない");
});

test("メゾネットの 3 周目はパス（nj_113）・取得元 ID も別", () => {
  assert.equal(CHINTAI_MAISONETTE_PATH, "nj_113");
  const u = chintaiSearchUrl("fukuokashichuo", 1, undefined, "maisonette");
  assert.ok(u.startsWith("https://suumo.jp/chintai/fukuoka/sc_fukuokashichuo/nj_113/?"), u);
  assert.ok(u.includes("ct=20.0") && u.includes("md=10"), "絞り込みクエリはパスの上に載る");
  assert.ok(!u.includes("tc="), "メゾネットはチェックボックス（tc）では絞れない");
  assert.ok(chintaiSearchUrl("kasuga", 2, undefined, "maisonette").endsWith("&page=2"));
  const src = new ChintaiSource({ maisonette: true });
  assert.equal(src.id, CHINTAI_MAISONETTE_SOURCE_ID);
  assert.equal(src.round, "maisonette");
  assert.deepEqual(src.targets(), new ChintaiSource().targets());
  assert.equal(CRAWL_KINDS.chintai_maisonette.sourceId, CHINTAI_MAISONETTE_SOURCE_ID);
  assert.equal(listingKindOf("chintai_maisonette"), "rent");
  assert.equal(parseCrawlKind("chintai_maisonette"), "chintai_maisonette");
  // 周回は 1 つずつ（ペットとメゾネットを同時に付けない）
  assert.throws(() => new ChintaiSource({ pets: true, maisonette: true }));
});

test("間取り詳細 → LDK の畳数 / 階建 → 部屋の階・建物の階数", () => {
  // ⚠️ SUUMO は「畳」の字を書かない。"LDK16.4" の形で出る
  assert.equal(parseLdkTatami("和6 洋7 洋5.2 LDK16.4"), 16.4);
  assert.equal(parseLdkTatami("洋10.8 洋6.7 洋4.7 LDK17.6"), 17.6);
  assert.equal(parseLdkTatami("和4.5 洋6 洋6 洋5 LDK18"), 18);
  assert.equal(parseLdkTatami("洋8 洋6 DK7"), null, "L を含まない間取りには LDK 畳数を作らない");
  assert.equal(parseLdkTatami("洋8 LD14 K4"), 14, "LD も L を含むので拾う");
  assert.equal(parseLdkTatami(null), null);
  assert.equal(parseLdkTatami("-"), null);
  assert.deepEqual(parseDetailFloors("4階/8階建"), { roomFloor: 4, buildingFloors: 8 });
  assert.deepEqual(parseDetailFloors("1階/地上3階建"), { roomFloor: 1, buildingFloors: 3 });
  assert.deepEqual(parseDetailFloors(null), { roomFloor: null, buildingFloors: null });
  assert.equal(chintaiDetailUrl("000109723289", "100437646092"), "https://suumo.jp/chintai/jnc_000109723289/?bc=100437646092");
  assert.equal(CHINTAI_DETAIL_MAX_PER_RUN, 60, "1 回の実行で取る詳細ページの上限（60 秒間隔なので ≒1 時間）");
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

/**
 * 賃料の取り違えが起きないこと（2026-09-26 の外れ値の調査から）。
 * 建物 1 件に複数の部屋があるとき、各行の 賃料・管理費・敷金・礼金・面積 は**その行のもの**で、
 * 隣の行や管理費の欄が賃料に混ざらない。実ページの 129 個の賃料表記には幅（"9.3万円〜13.3万円"）も
 * 月数表記も無く、1 行 1 値だった（parseYen が幅の下限だけ拾う筋は実ページには無い）。
 */
test("架空ページ: 同じ建物の部屋どうしで賃料・管理費が混ざらない", () => {
  for (const slug of ["fukuokashichuo", "kasuga", "onojo"]) {
    const src = new Map(fakeChintaiBuildings(slug, 1).map((b) => [b.name, b] as const));
    // 1 ページに収まらない建物があるので、名前で突き合わせる（ページ分割の都合で件数は一致しないことがある）
    const parsed = parseChintaiListPage(renderFakeChintaiPage(slug, 1, 1).html, "40133", 2026);
    assert.ok(parsed.buildings.length > 0, `${slug}: 建物が 1 件以上`);
    for (const [i, b] of parsed.buildings.entries()) {
      assert.ok(src.has(b.buildingName ?? ""), `${slug}[${i}]: 建物名 ${b.buildingName} が架空データにある`);
      const want = src.get(b.buildingName ?? "")!;
      assert.equal(b.rooms.length, want.rooms.length, `${slug}[${i}]: 部屋の数`);
      for (const [j, room] of b.rooms.entries()) {
        const w = want.rooms[j]!;
        assert.equal(room.externalId, w.id, `${slug}[${i}][${j}]: 部屋 ID`);
        assert.equal(room.rentYen, Math.round(w.rentMan * 10000), `${slug}[${i}][${j}]: 賃料はその行のもの`);
        assert.equal(room.areaSqm, w.area, `${slug}[${i}][${j}]: 面積はその行のもの`);
        assert.equal(room.floorPlan, w.madori, `${slug}[${i}][${j}]: 間取りはその行のもの`);
        // 管理費（"-" は不明）を賃料に取り違えない
        assert.equal(room.adminFeeYen, w.admin === "-" ? null : Number(w.admin.replace("円", "")), `${slug}[${i}][${j}]: 管理費`);
        assert.notEqual(room.rentYen, room.adminFeeYen, `${slug}[${i}][${j}]: 賃料に管理費を入れない`);
      }
      // 同じ建物で賃料が全部同じになる（＝1 行目の値を配ってしまう）ことが無い
      const rents = new Set(b.rooms.map((r) => r.rentYen));
      if (new Set(want.rooms.map((r) => r.rentMan)).size > 1) assert.ok(rents.size > 1, `${slug}[${i}]: 部屋ごとに賃料が違う`);
    }
  }
});

test("1 部屋 → ListingRecord（賃料が読めない部屋は捨てる・掲載日は入れない）", () => {
  const b = parseChintaiListPage(renderFakeChintaiPage("onojo", 1, 1).html, "40219", 2026).buildings[0]!;
  const r = toRentListingRecord(b, b.rooms[0]!)!;
  assert.equal(r.kind, "rent");
  assert.equal(r.price, b.rooms[0]!.rentYen);
  assert.equal(r.wardCode, "40219");
  // ⚠️ 所在地は建物側にしかない。部屋の行に配らないと listings.address が全件 NULL になる（2026-09-26 の回帰）
  assert.equal(r.address, b.address);
  assert.ok(r.address, "住所が空のまま取り込まない");
  assert.equal(r.buildingYear, b.buildingYear);
  assert.equal(r.petsAllowed, undefined, "1 周目はペット可否が分からない");
  assert.equal(r.listedOn, undefined, "掲載日・情報公開日は一覧に無い（賃貸では常に NULL）");
  assert.equal(toRentListingRecord(b, b.rooms[0]!, true)!.petsAllowed, true);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: null }), null);
  assert.equal(toRentListingRecord(b, { ...b.rooms[0]!, rentYen: 0 }), null);
});

/**
 * ⚠️ 取りこぼしの回帰テスト（2026-09-26 に address で実際に起きた・e1c26b3）。
 * パーサが値を持っていても、**記録（toRentListingRecord）→ 取り込みの検証（parseIngestRequest）→ D1 に渡す行（listingUpsertRow）**の
 * どこかで写し忘れると D1 まで届かない。建物の階数・部屋の階・メゾネットの 3 つを各段で追いかける。
 */
test("階数・メゾネットが パーサ → 記録 → 取り込みの検証 → D1 の行 の各段で生きている", () => {
  const page = parseChintaiListPage(renderFakeChintaiPage("fukuokashichuo", 1, 1).html, "40133", 2026);
  const b = page.buildings[0]!;
  assert.notEqual(b.buildingFloors, null, "① パーサ: 建物の階数");
  const room = b.rooms.find((r) => r.roomFloor !== null)!;
  assert.ok(room, "① パーサ: 階の読める部屋がある");

  // ② 記録に写る（建物側の階数が全部屋に配られる）
  const rec = toRentListingRecord(b, room)!;
  assert.equal(rec.buildingFloors, b.buildingFloors, "② 記録: 建物の階数");
  assert.equal(rec.roomFloor, room.roomFloor, "② 記録: 部屋の階");

  // ③ 取り込み要求の検証を通っても落ちない（JSON を往復させる）
  const runId = `${CHINTAI_SOURCE_ID}:2026-09-26`;
  const req = parseIngestRequest(
    JSON.parse(
      JSON.stringify({
        op: "page", kind: "chintai", runId, areaCode: "40133", page: 1,
        url: "https://suumo.jp/chintai/fukuoka/sc_fukuokashichuo/", fetchedAt: "2026-09-26T00:00:00.000Z",
        outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: 1, skipped: 0, records: [rec] } },
      }),
    ),
  );
  assert.equal(req.op, "page");
  const got = req.op === "page" && req.outcome.kind === "parsed" ? (req.outcome.page.records[0] as typeof rec) : null;
  assert.ok(got);
  assert.equal(got.buildingFloors, b.buildingFloors, "③ 取り込みの検証: 建物の階数");
  assert.equal(got.roomFloor, room.roomFloor, "③ 取り込みの検証: 部屋の階");

  // ④ D1 の UPSERT に渡す行（鍵は UPSERT_LISTINGS の json_extract と 1:1）
  const row = listingUpsertRow(got, "40133");
  assert.equal(row.bfl, b.buildingFloors, "④ D1 の行: building_floors");
  assert.equal(row.rfl, room.roomFloor, "④ D1 の行: room_floor");
  assert.equal(row.addr, rec.address, "④ D1 の行: address（2026-09-26 に落ちていた項目）");

  // メゾネット（室内 2 層）は "1-2階" の部屋で立つ。**立たない部屋は 0 ではなく NULL（不明）**
  const multi = page.buildings.flatMap((x) => x.rooms.map((r) => [x, r] as const)).find(([, r]) => r.multiLevel);
  assert.ok(multi, "架空ページに室内 2 層（1-2階）の部屋がある");
  const mRec = toRentListingRecord(multi[0], multi[1])!;
  assert.equal(mRec.maisonette, true, "② 記録: 階が範囲表記ならメゾネット");
  assert.equal(listingUpsertRow(mRec, "40133").mais, 1, "④ D1 の行: maisonette = 1");
  assert.equal(rec.maisonette, undefined, "単独の階の部屋にはメゾネットの印を立てない（不明のまま）");
  assert.equal(listingUpsertRow(rec, "40133").mais, null, "④ D1 の行: 不明は NULL（0 を入れない）");
});

test("架空ページ: メゾネットの 3 周目（nj_113）は見えた部屋に maisonette を立てるだけ", () => {
  const src = new ChintaiSource({ maisonette: true, origin: "http://127.0.0.1:8790" });
  const t = { areaCode: "40133", key: "fukuokashichuo" };
  assert.ok(src.pageUrl(t, 1).includes("/nj_113/"));
  const page = renderFakeChintaiPage("fukuokashichuo", 1, 1, "maisonette");
  assert.equal(page.status, 200);
  const recs = src.parsePage(page.html, t);
  assert.ok(recs.records.length > 0);
  assert.equal(recs.records.every((r) => r.maisonette === true), true, "3 周目で見えた部屋は全部メゾネット");
  // 1 周目は「階が範囲表記の部屋」だけに印が付き、それ以外は不明のまま（3 周目の方が拾える）
  const plain = new ChintaiSource().parsePage(renderFakeChintaiPage("fukuokashichuo", 1, 1).html, t);
  assert.ok(plain.records.some((r) => r.maisonette === undefined), "1 周目には不明のままの部屋がある");
  assert.ok(
    recs.records.length >= plain.records.filter((r) => r.maisonette).length,
    "3 周目は 1 周目の範囲表記だけより多く拾える",
  );
  // 取り込み要求としても通る（rent だけ・runId は 3 周目の取得元）
  const req = parseIngestRequest(
    JSON.parse(
      JSON.stringify({
        op: "page", kind: "chintai_maisonette", runId: `${CHINTAI_MAISONETTE_SOURCE_ID}:2026-09-26`, areaCode: "40133",
        page: 1, url: src.pageUrl(t, 1), fetchedAt: "2026-09-26T00:00:00.000Z",
        outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: 1, skipped: 0, records: recs.records } },
      }),
    ),
  );
  assert.equal(req.op, "page");
  // kind と取得元が食い違う要求は受けない（runId の頭が取得元 ID と一致しないと弾く）
  assert.throws(
    () => parseIngestRequest({ ...JSON.parse(JSON.stringify(req)), runId: `${CHINTAI_SOURCE_ID}:2026-09-26` }),
    /runId と kind が合わない/,
  );
});

test("架空ページ: 詳細ページから LDK の畳数が読める・取り込み要求（detail_*）の検証", () => {
  const room = fakeChintaiBuildings("fukuokashichuo", 1)[0]!.rooms[0]!;
  const d = renderFakeChintaiDetail(room.id, 1);
  assert.equal(d.status, 200);
  assert.equal(hasChintaiDetailStructure(d.html), true);
  const parsed = parseChintaiDetailPage(d.html);
  assert.equal(parsed.ldkTatami, room.ldkTatami);
  assert.notEqual(parsed.buildingFloors, null);
  assert.equal(renderFakeChintaiDetail("999999999999", 1).status, 404);

  // 取り込み要求: 対象をもらう → 結果を返す。どちらも kind=chintai だけ
  const t = parseIngestRequest({ op: "detail_targets", kind: "chintai", limit: 60 });
  assert.equal(t.op, "detail_targets");
  assert.throws(() => parseIngestRequest({ op: "detail_targets", kind: "chintai", limit: CHINTAI_DETAIL_MAX_PER_RUN + 1 }));
  assert.throws(() => parseIngestRequest({ op: "detail_targets", kind: "chintai_pets", limit: 10 }), /kind=chintai だけ/);
  const r = parseIngestRequest({
    op: "detail_results", kind: "chintai", fetchedAt: "2026-09-26T00:00:00.000Z",
    results: [{ externalId: room.id, ldkTatami: 16.4 }, { externalId: "100000000001", ldkTatami: null }],
  });
  assert.equal(r.op, "detail_results");
  // ⚠️ 読めなかった部屋（null）も送る = 「取った」印になり、次回また取りに行かない
  if (r.op === "detail_results") assert.deepEqual(r.results[1], { externalId: "100000000001", ldkTatami: null });
  assert.throws(() => parseIngestRequest({
    op: "detail_results", kind: "chintai", fetchedAt: "2026-09-26T00:00:00.000Z",
    results: [{ externalId: room.id, ldkTatami: 0 }],
  }), /ldkTatami が不正/);
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

/**
 * 2026-09-26 の不具合の回帰テスト。本番 D1 で listings.address が 2291 件すべて NULL だった。
 * 原因はパーサではなく toRentListingRecord が建物の住所を部屋の記録に写していなかったこと
 * （住所は建物単位の cassetteitem_detail-col1 にあり、部屋の <tr class="js-cassette_link"> には無い）。
 * 住所が入らないと /listings/picks が住所から起こす町名（districtNameFromAddress）も丸ごと効かなくなる。
 */
test("実データ: 建物の住所が部屋ごとの記録に付く → 市区町村コードと町名が起こせる", { skip: !hasProbe("chuo_p1") && "listing-probe/chintai が無い" }, () => {
  for (const [name, code] of [["chuo_p1", "40133"], ["chuo_p1_pets", "40133"], ["chuo_p2", "40133"], ["kasuga_p1", "40218"], ["hisayama_p1", "40348"]] as const) {
    if (!hasProbe(name)) continue;
    const p = parseChintaiListPage(probe(name), code, 2026);
    // 建物 → 部屋の紐づけ: 同じ建物の部屋は全部その建物の住所を持つ
    for (const b of p.buildings) {
      assert.ok(b.address, `${name}: 建物の住所`);
      for (const room of b.rooms) {
        const r = toRentListingRecord(b, room)!;
        assert.equal(r.address, b.address, `${name}: 部屋 ${room.externalId} に建物の住所が付く`);
      }
    }
    // 取り込む記録として見ても、住所・市区町村コード・住所から起こす町名が全件そろう
    // （fallbackCode ではなく住所から出ていることを見るため、わざと違う市区町村コードを渡す）
    const recs = new ChintaiSource().parsePage(probe(name), { areaCode: "40999", key: "dummy" });
    assert.ok(recs.records.length > 0, `${name}: 記録が 1 件以上`);
    assert.equal(recs.records.filter((r) => !r.address).length, 0, `${name}: 住所が NULL の記録は 0 件`);
    assert.equal(recs.records.filter((r) => r.wardCode !== code).length, 0, `${name}: 住所から市区町村コードが出る（fallback を使っていない）`);
    assert.equal(recs.records.filter((r) => !districtNameFromAddress(r.address)).length, 0, `${name}: 住所から町名（district_name）が起こせる`);
  }

  // 具体例（中央区 1 ページ目の先頭の建物）: 住所・町名・市区町村コード
  const first = parseChintaiListPage(probe("chuo_p1"), "40133", 2026).buildings[0]!;
  const rec = toRentListingRecord(first, first.rooms[0]!)!;
  assert.equal(rec.address, "福岡県福岡市中央区地行４");
  assert.equal(rec.wardCode, "40133");
  assert.equal(districtNameFromAddress(rec.address), "地行");
  // 建物に 2 部屋以上あるときも、2 つ目以降に同じ住所が付く（部屋の行の外を見ている）
  assert.ok(first.rooms.length > 1);
  assert.equal(toRentListingRecord(first, first.rooms[1]!)!.address, rec.address);
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

/**
 * 2026-09-26 に本番で取った実ページ。一覧の階の表記は "1階"〜"14階"・"1-2階"・"-" しか出なかった。
 * building_floors / room_floor が実データでちゃんと埋まること（＝画面に出せること）を見る。
 */
test("実データ: 建物の階数・部屋の階が取れる（記録と D1 の行まで通る）", { skip: !hasProbe("chuo_p1") && "listing-probe/chintai が無い" }, () => {
  const p = parseChintaiListPage(probe("chuo_p1"), "40133", 2026);
  assert.equal(p.buildings.filter((b) => b.buildingFloors === null).length, 0, "20 建物すべてで階建が読める");
  const rooms = p.buildings.flatMap((b) => b.rooms);
  assert.ok(rooms.filter((r) => r.roomFloor !== null).length >= rooms.length * 0.9, "ほとんどの部屋で階が読める");
  assert.equal(rooms[0]!.roomFloor, 4, "先頭の部屋は 4階");
  assert.equal(rooms[0]!.multiLevel, false);

  // 記録 → D1 の行まで落ちない
  const recs = new ChintaiSource().parsePage(probe("chuo_p1"), { areaCode: "40133", key: "fukuokashichuo" });
  assert.equal(recs.records.filter((r) => r.buildingFloors === undefined).length, 0, "建物の階数が全件に付く");
  const rows = recs.records.map((r) => listingUpsertRow(r, "40133"));
  assert.equal(rows.filter((r) => r.bfl === null).length, 0, "D1 の行でも building_floors が埋まる");
  assert.ok(rows.filter((r) => r.rfl !== null).length >= rows.length * 0.9);
});

test("実データ: メゾネット絞り込み（/nj_113/）の 3 周目", { skip: !hasProbe("chuo_p1_maisonette") && "listing-probe/chintai が無い" }, () => {
  const m = parseChintaiListPage(probe("chuo_p1_maisonette"), "40133", 2026);
  const plain = parseChintaiListPage(probe("chuo_p1"), "40133", 2026);
  // 2026-09-26 の実ページ: 中央区 734 件 → メゾネットだけだと 37 件・1 ページ
  assert.equal(m.totalHits, 37, "メゾネットだけに絞ると件数が減る（734 → 37）");
  assert.equal(m.maxPageLinked, 1, "1 ページで収まる（1 周目は 8 ページ）");
  assert.ok((m.totalHits ?? 0) < (plain.totalHits ?? 0));
  const rooms = m.buildings.flatMap((b) => b.rooms);
  assert.ok(rooms.length > 0);
  // ⚠️ ここが肝心: 一覧の階が "1階"（単独）のメゾネットが実在する。
  //    だから「階が 1-2階 なら」の判定だけでは足りず、3 周目（nj_113）が要る
  assert.ok(rooms.some((r) => r.multiLevel), "階が範囲表記（1-2階）の部屋がある");
  assert.ok(rooms.some((r) => !r.multiLevel && r.roomFloor !== null), "階が単独表記のメゾネットもある");

  const recs = new ChintaiSource({ maisonette: true }).parsePage(probe("chuo_p1_maisonette"), { areaCode: "40133", key: "fukuokashichuo" });
  assert.ok(recs.records.length > 0);
  assert.equal(recs.records.every((r) => r.maisonette === true), true, "3 周目で見えた部屋は全部メゾネット");
  // 取得時の絞り込みクエリ（賃料・面積・間取り）はパスの上でも効いている（3LDK 以上・60㎡ 以上しか返らない）
  assert.equal(rooms.filter((r) => (r.areaSqm ?? 0) < 60).length, 0);
  assert.equal(rooms.filter((r) => !/^[3-9]/.test(r.floorPlan ?? "")).length, 0);
});

/**
 * 詳細ページの実データ（2026-09-26 に本番で 3 ページ取った）。
 * ⚠️ **「畳」の字は 1 回も出てこない**。畳数は「間取り詳細」の "LDK16.4" の形で書かれている。
 */
test("実データ: 詳細ページの間取り詳細 → LDK の畳数", { skip: !hasDetailProbe("detail_1") && "listing-probe/chintai/detail が無い" }, () => {
  const h = detailProbe("detail_1");
  assert.equal(h.includes("畳"), false, "SUUMO は「畳」の字を書かない（単位が省略されている）");
  assert.equal(hasChintaiDetailStructure(h), true);
  const d = parseChintaiDetailPage(h);
  assert.equal(d.layoutDetail, "和6 洋7 洋5.2 LDK16.4");
  assert.equal(d.ldkTatami, 16.4);
  assert.deepEqual({ r: d.roomFloor, b: d.buildingFloors }, { r: 4, b: 8 }, "階建は 4階/8階建");
  assert.equal(d.maisonette, false, "メゾネットのタグが無い");

  if (hasDetailProbe("detail_2_maisonette")) {
    const m = parseChintaiDetailPage(detailProbe("detail_2_maisonette"));
    assert.equal(m.ldkTatami, 17.6);
    assert.deepEqual({ r: m.roomFloor, b: m.buildingFloors }, { r: 1, b: 3 }, "「1階/地上3階建」も読む");
    // ⚠️ この部屋は一覧では "1階"（単独）なのにメゾネット。範囲表記だけの判定では取りこぼす
    assert.equal(m.maisonette, true, "特徴のタグに「メゾネット」がある");
  }
  if (hasDetailProbe("detail_3")) {
    const d3 = parseChintaiDetailPage(detailProbe("detail_3"));
    assert.equal(d3.ldkTatami, 18);
    assert.equal(d3.layoutDetail, "和4.5 洋6 洋6 洋5 LDK18");
  }
});

/**
 * 管理費・敷金・礼金の "-" について（README にも書いた）。
 * **詳細ページでも "-" のまま**なので、「0 円」なのか「表記なし」なのかは詳細ページを取っても判別できない。
 * 一覧と同じく不明（NULL）のままにする、という 0006 の判断は詳細ページを見ても変わらない。
 */
test("実データ: 管理費の '-' は詳細ページでも '-'（0 円か表記なしか判別できない）", { skip: !hasDetailProbe("detail_1") && "listing-probe/chintai/detail が無い" }, () => {
  const text = detailProbe("detail_1").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  assert.match(text, /管理費・共益費:\s*-/, "詳細ページの管理費も '-'");
  // 一覧の同じ部屋も '-' だった（chuo_p1 の先頭の部屋）
  if (hasProbe("chuo_p1")) {
    const room = parseChintaiListPage(probe("chuo_p1"), "40133", 2026).buildings[0]!.rooms[0]!;
    assert.equal(room.adminFeeYen, null, "一覧でも不明（0 円と決めつけない）");
  }
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

// 掲載の保存経路（src/listing-crawl-core.ts の UPSERT_LISTINGS_SQL・UPDATE_DETAIL_SQL）を
// **素の SQLite で実際に実行して**確かめる。D1 と同じ SQLite なので、SQL の書き間違い・上書きの事故はここで捕まる。
//
// ⚠️ ここで見たいのは「詳細ページの周回と一覧の周回が互いの値を壊さないか」:
//   - 詳細（UPDATE_DETAIL_SQL）は building_floors / room_floor を**一覧優先**で、NULL のときだけ補う
//   - 詳細は maisonette を**見つかったときだけ 1**（0 は書かない）
//   - 毎週の一覧（UPSERT_LISTINGS_SQL）は ldk_tatami / detail_fetched_at を触らず、
//     詳細で補った階も消さない。maisonette だけは毎週 0 に戻す（二値・0008。3 周目が立て直す）
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  COORD_PRIORITY,
  COORD_TARGETS_SQL,
  type CoordResult,
  GSI_TARGETS_SQL,
  SHARE_COORDS_SQLS,
  UPDATE_GSI_COORDS_SQL,
  coordUpdateRow,
  detailUpdateRow,
  listingUpsertRow,
  UPDATE_COORDS_SQL,
  UPDATE_DETAIL_SQL,
  UPSERT_LISTINGS_SQL,
} from "../src/listing-crawl-core.ts";
import { SUUMO_SOURCE_ID } from "../src/suumo.ts";
import { CHINTAI_SOURCE_ID } from "../src/suumo-chintai.ts";
import type { ListingRecord } from "../src/listing-types.ts";

/** migrations/ の置き場（どこから実行しても読めるように） */
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationFiles = () => readdirSync(MIGRATIONS).sort();
const applyMigration = (db: DatabaseSync, f: string) => db.exec(readFileSync(`${MIGRATIONS}/${f}`, "utf8"));

/** 本番と同じ器を migrations/ から組む（スキーマを二重に書かない） */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of migrationFiles()) applyMigration(db, f);
  return db;
}

interface Row {
  building_floors: number | null;
  room_floor: number | null;
  maisonette: number | null;
  ldk_tatami: number | null;
  detail_fetched_at: string | null;
}

const rentRecord = (over: Partial<ListingRecord> = {}): ListingRecord => ({
  externalId: "100437646092",
  kind: "rent",
  price: 128_000,
  url: "https://suumo.jp/chintai/jnc_000109723289/?bc=100437646092",
  buildingName: "架空ハイツ",
  buildingYear: 2005,
  areaSqm: 77,
  floorPlan: "3LDK",
  petsAllowed: true,
  ...over,
});

/** 一覧 1 ページぶんの upsert（1 周目・suumo:chintai） */
function upsertList(db: DatabaseSync, date: string, records: ListingRecord[]): void {
  const rows = records.map((r) => listingUpsertRow(r, "40133"));
  db.prepare(UPSERT_LISTINGS_SQL).run(CHINTAI_SOURCE_ID, date, `${CHINTAI_SOURCE_ID}:${date}`, JSON.stringify(rows), "rent");
}

/** 詳細ページの結果の反映 */
function applyDetail(db: DatabaseSync, fetchedAt: string, results: Parameters<typeof detailUpdateRow>[0][]): void {
  db.prepare(UPDATE_DETAIL_SQL).run(CHINTAI_SOURCE_ID, fetchedAt, JSON.stringify(results.map(detailUpdateRow)));
}

const read = (db: DatabaseSync, id = "100437646092"): Row => {
  const r = db
    .prepare("SELECT building_floors, room_floor, maisonette, ldk_tatami, detail_fetched_at FROM listings WHERE external_id = ?")
    .get(id) as unknown as Row;
  return { ...r }; // node:sqlite は prototype なしのオブジェクトを返すので deepEqual 用に写す
};

test("詳細ページの結果が D1 に入る（畳数・階・メゾネット）・一覧が読めていた階は上書きしない", () => {
  const db = freshDb();
  // 一覧で階が読めた部屋と、読めなかった部屋の 2 件
  upsertList(db, "2026-09-26", [
    rentRecord({ buildingFloors: 8, roomFloor: 4 }),
    rentRecord({ externalId: "100437646093", buildingFloors: undefined, roomFloor: undefined }),
  ]);
  assert.deepEqual(read(db), { building_floors: 8, room_floor: 4, maisonette: 0, ldk_tatami: null, detail_fetched_at: null });

  applyDetail(db, "2026-09-26T16:00:00Z", [
    // 詳細では階が 1階/3階建 に見えている（= 一覧と食い違う）。⚠️ 一覧を正にする
    { externalId: "100437646092", ldkTatami: 15.9, roomFloor: 1, buildingFloors: 3, maisonette: false },
    // 一覧で読めなかった部屋は詳細で埋まる。メゾネットのタグも見えた
    { externalId: "100437646093", ldkTatami: 16.4, roomFloor: 2, buildingFloors: 5, maisonette: true },
  ]);

  assert.deepEqual(read(db), {
    building_floors: 8,
    room_floor: 4,
    maisonette: 0,
    ldk_tatami: 15.9,
    detail_fetched_at: "2026-09-26T16:00:00Z",
  }, "一覧に値があれば詳細で壊さない・畳数は入る");
  assert.deepEqual(read(db, "100437646093"), {
    building_floors: 5,
    room_floor: 2,
    maisonette: 1,
    ldk_tatami: 16.4,
    detail_fetched_at: "2026-09-26T16:00:00Z",
  }, "一覧が NULL のときだけ詳細で補う・メゾネットのタグは 1 を立てる");
});

test("畳数が読めなくても detail_fetched_at は入る（取り直さない印）・メゾネットの 1 は詳細で消えない", () => {
  const db = freshDb();
  upsertList(db, "2026-09-26", [rentRecord({ maisonette: true })]);
  assert.equal(read(db).maisonette, 1, "3 周目で見えた部屋（記録に maisonette がある）は 1");

  applyDetail(db, "2026-09-26T16:00:00Z", [
    { externalId: "100437646092", ldkTatami: null, roomFloor: null, buildingFloors: null, maisonette: false },
  ]);
  const r = read(db);
  assert.equal(r.ldk_tatami, null);
  assert.equal(r.detail_fetched_at, "2026-09-26T16:00:00Z");
  assert.equal(r.maisonette, 1, "詳細でタグが見つからないことを「メゾネットでない」の証拠にしない（0 を書かない）");
});

test("毎週の一覧クロールが詳細由来の値を消さない（畳数・取得時刻・詳細で補った階）", () => {
  const db = freshDb();
  // 1 週目: 一覧では階が読めず、詳細で補った
  upsertList(db, "2026-09-26", [rentRecord()]);
  applyDetail(db, "2026-09-26T16:00:00Z", [
    { externalId: "100437646092", ldkTatami: 15.9, roomFloor: 2, buildingFloors: 5, maisonette: true },
  ]);
  assert.deepEqual(read(db), {
    building_floors: 5,
    room_floor: 2,
    maisonette: 1,
    ldk_tatami: 15.9,
    detail_fetched_at: "2026-09-26T16:00:00Z",
  });

  // 2 週目の 1 周目（一覧では相変わらず階が読めない・値下げもある）
  upsertList(db, "2026-10-03", [rentRecord({ price: 125_000 })]);
  const r = read(db);
  assert.equal(r.ldk_tatami, 15.9, "ldk_tatami は一覧クロールで触らない");
  assert.equal(r.detail_fetched_at, "2026-09-26T16:00:00Z", "detail_fetched_at も触らない（取り直さない）");
  assert.equal(r.building_floors, 5, "詳細で補った階建を毎週 NULL に戻さない");
  assert.equal(r.room_floor, 2, "詳細で補った部屋の階も戻さない");
  // ⚠️ メゾネットだけは毎週 0 に戻す（3 周目が同じ日に立て直す前提の割り切り・0008）
  assert.equal(r.maisonette, 0, "maisonette は 1 周目が毎週 0 に戻す（NULL にはしない）");
  assert.equal(
    (db.prepare("SELECT current_price AS p, price_cut_count AS c FROM listings WHERE external_id = ?").get("100437646092") as { p: number; c: number }).c,
    1,
    "値下げの数え方は変わっていない",
  );

  // 3 周目（メゾネット絞り込み）が立て直す
  db.prepare("UPDATE listings SET maisonette = 1 WHERE source = ? AND external_id = ?").run(CHINTAI_SOURCE_ID, "100437646092");
  assert.equal(read(db).maisonette, 1);
});

test("一覧に階がある行では、一覧の値が毎週正になる（詳細で補った値より強い）", () => {
  const db = freshDb();
  upsertList(db, "2026-09-26", [rentRecord()]);
  applyDetail(db, "2026-09-26T16:00:00Z", [
    { externalId: "100437646092", ldkTatami: 16, roomFloor: 1, buildingFloors: 3, maisonette: false },
  ]);
  upsertList(db, "2026-10-03", [rentRecord({ buildingFloors: 8, roomFloor: 4 })]);
  const r = read(db);
  assert.equal(r.building_floors, 8);
  assert.equal(r.room_floor, 4);
});

test("0008 のマイグレーション: 既存の NULL は 0 に埋まる", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  for (const f of files.filter((x) => !x.startsWith("0008"))) applyMigration(db, f);
  db.prepare(
    `INSERT INTO listings (source, external_id, kind, first_seen, last_seen, current_price, maisonette)
     VALUES (?, '1', 'rent', '2026-09-01', '2026-09-01', 100000, NULL)`,
  ).run(CHINTAI_SOURCE_ID);
  for (const f of files.filter((x) => x.startsWith("0008"))) applyMigration(db, f);
  assert.equal(read(db, "1").maisonette, 0, "移行後は「メゾネットでない」の 0");
});

// ---------------------------------------------------------------------------
// 座標（0009・2026-10-31）: 一覧の毎日の UPSERT が lat / lng / coord_fetched_at を消さないこと
// ---------------------------------------------------------------------------

interface CoordRow {
  lat: number | null;
  lng: number | null;
  coord_fetched_at: string | null;
}
const readCoord = (db: DatabaseSync, id: string, source = CHINTAI_SOURCE_ID): CoordRow => {
  const r = db.prepare("SELECT lat, lng, coord_fetched_at FROM listings WHERE source = ? AND external_id = ?").get(source, id) as unknown as CoordRow;
  return { ...r };
};
function applyCoords(db: DatabaseSync, source: string, fetchedAt: string, results: CoordResult[]): void {
  db.prepare(UPDATE_COORDS_SQL).run(source, fetchedAt, JSON.stringify(results.map(coordUpdateRow)));
}
const saleRecord = (over: Partial<ListingRecord> = {}): ListingRecord => ({
  externalId: "21806428",
  kind: "sale",
  price: 45_000_000,
  url: "https://suumo.jp/ms/chuko/fukuoka/sc_fukuokashichuo/nc_21806428/",
  buildingName: "架空マンション",
  buildingYear: 2010,
  areaSqm: 72,
  floorPlan: "3LDK",
  ...over,
});
function upsertSale(db: DatabaseSync, date: string, records: ListingRecord[]): void {
  const rows = records.map((r) => listingUpsertRow(r, "40133"));
  db.prepare(UPSERT_LISTINGS_SQL).run(SUUMO_SOURCE_ID, date, `${SUUMO_SOURCE_ID}:${date}`, JSON.stringify(rows), "sale");
}

test("座標: 反映される・読めなくても coord_fetched_at が入る・一覧の再クロールで消えない（中古・賃貸）", () => {
  const db = freshDb();
  upsertList(db, "2026-10-31", [rentRecord(), rentRecord({ externalId: "100437646093" })]);
  upsertSale(db, "2026-10-31", [saleRecord()]);
  assert.deepEqual(readCoord(db, "100437646092"), { lat: null, lng: null, coord_fetched_at: null });

  applyCoords(db, CHINTAI_SOURCE_ID, "2026-10-31T11:00:00Z", [
    { externalId: "100437646092", kind: "rent", lat: 33.5735, lng: 130.3914 },
    { externalId: "100437646093", kind: "rent", lat: null, lng: null },
  ]);
  applyCoords(db, SUUMO_SOURCE_ID, "2026-10-31T11:00:00Z", [{ externalId: "21806428", kind: "sale", lat: 33.578, lng: 130.4031 }]);
  assert.deepEqual(readCoord(db, "100437646092"), { lat: 33.5735, lng: 130.3914, coord_fetched_at: "2026-10-31T11:00:00Z" });
  assert.deepEqual(readCoord(db, "100437646093"), { lat: null, lng: null, coord_fetched_at: "2026-10-31T11:00:00Z" }, "読めなくても取りに行った印は入る");
  assert.deepEqual(readCoord(db, "21806428", SUUMO_SOURCE_ID), { lat: 33.578, lng: 130.4031, coord_fetched_at: "2026-10-31T11:00:00Z" });

  // 翌日の一覧クロール（値下げ・住所の表記ゆれ・階の変化があっても座標は触らない）
  upsertList(db, "2026-11-01", [rentRecord({ price: 120_000, address: "福岡県福岡市中央区平尾浄水町" }), rentRecord({ externalId: "100437646093" })]);
  upsertSale(db, "2026-11-01", [saleRecord({ price: 44_000_000 })]);
  assert.deepEqual(readCoord(db, "100437646092"), { lat: 33.5735, lng: 130.3914, coord_fetched_at: "2026-10-31T11:00:00Z" }, "賃貸の座標が残る");
  assert.deepEqual(readCoord(db, "100437646093"), { lat: null, lng: null, coord_fetched_at: "2026-10-31T11:00:00Z" }, "取りに行った印も残る（取り直さない）");
  assert.deepEqual(readCoord(db, "21806428", SUUMO_SOURCE_ID), { lat: 33.578, lng: 130.4031, coord_fetched_at: "2026-10-31T11:00:00Z" }, "中古の座標が残る");

  // 詳細ページの周回（畳数）も座標を触らない
  applyDetail(db, "2026-11-01T16:00:00Z", [{ externalId: "100437646092", ldkTatami: 16, roomFloor: 2, buildingFloors: 5, maisonette: false }]);
  assert.equal(readCoord(db, "100437646092").lat, 33.5735);

  // 座標の取り直しで読めなかった（null）ときに、前の座標を消さない
  applyCoords(db, CHINTAI_SOURCE_ID, "2026-11-02T11:00:00Z", [{ externalId: "100437646092", kind: "rent", lat: null, lng: null }]);
  assert.deepEqual(readCoord(db, "100437646092"), { lat: 33.5735, lng: 130.3914, coord_fetched_at: "2026-11-02T11:00:00Z" });
  // 取得元が違う行は触らない（同じ external_id でも）
  applyCoords(db, SUUMO_SOURCE_ID, "2026-11-02T11:00:00Z", [{ externalId: "100437646093", kind: "sale", lat: 33.1, lng: 130.1 }]);
  assert.deepEqual(readCoord(db, "100437646093"), { lat: null, lng: null, coord_fetched_at: "2026-10-31T11:00:00Z" });
});

test("座標を取る相手: 掲載中・未取得だけ・条件に近いもの（60㎡以上・3部屋以上・売買5,500万以下・賃貸18万以下）が先", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s-far", price: 60_000_000 }), // 5,500 万超 → 後
    saleRecord({ externalId: "s-near", price: 55_000_000 }), // ちょうど → 先
  ]);
  upsertSale(db, "2026-10-02", [saleRecord({ externalId: "s-small", areaSqm: 59.9 })]); // 60㎡未満 → 後
  upsertList(db, "2026-10-03", [
    rentRecord({ externalId: "r-near", price: 180_000 }), // ちょうど → 先
    rentRecord({ externalId: "r-2ldk", floorPlan: "2LDK" }), // 2 部屋 → 後
    rentRecord({ externalId: "r-done" }),
    rentRecord({ externalId: "r-gone" }),
    rentRecord({ externalId: "r-nourl", url: undefined }),
  ]);
  applyCoords(db, CHINTAI_SOURCE_ID, "2026-10-31T11:00:00Z", [{ externalId: "r-done", kind: "rent", lat: 33.5, lng: 130.4 }]);
  db.prepare("UPDATE listings SET delisted_on = '2026-10-30' WHERE external_id = 'r-gone'").run();

  const p = COORD_PRIORITY;
  const rows = db
    .prepare(COORD_TARGETS_SQL)
    .all(SUUMO_SOURCE_ID, CHINTAI_SOURCE_ID, p.areaMin, p.roomsMin, p.saleMaxYen, p.rentMaxYen) as unknown as {
    external_id: string;
    kind: string;
    priority: number;
  }[];
  assert.deepEqual(
    rows.map((r) => [r.external_id, r.kind, r.priority]),
    [
      ["r-near", "rent", 1],
      ["r-2ldk", "rent", 0],
      ["s-near", "sale", 1],
      ["s-far", "sale", 0],
      ["s-small", "sale", 0],
    ],
    "賃貸が先（2026-11-01）・その中は条件に近いものが先・その中は古く見えたものが先。取得済み・掲載終了・URL なしは返らない",
  );
});

test("0009 のマイグレーション: 既存の行は座標なし（NULL）のまま足される", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  for (const f of files.filter((x) => x < "0009")) applyMigration(db, f);
  db.prepare(
    `INSERT INTO listings (source, external_id, kind, first_seen, last_seen, current_price) VALUES (?, '1', 'rent', '2026-09-01', '2026-09-01', 100000)`,
  ).run(CHINTAI_SOURCE_ID);
  for (const f of files.filter((x) => x >= "0009")) applyMigration(db, f);
  assert.deepEqual(readCoord(db, "1"), { lat: null, lng: null, coord_fetched_at: null });
});

// ---------------------------------------------------------------------------
// 0010（2026-11-01）: 座標の出どころ・同じ建物の使い回し・建物単位で賃貸優先の targets・国土地理院の仮座標
// ---------------------------------------------------------------------------

interface CoordRow2 extends CoordRow {
  coord_source: string | null;
  gsi_tried_at: string | null;
}
const readCoord2 = (db: DatabaseSync, id: string, source = CHINTAI_SOURCE_ID): CoordRow2 => {
  const r = db
    .prepare("SELECT lat, lng, coord_fetched_at, coord_source, gsi_tried_at FROM listings WHERE source = ? AND external_id = ?")
    .get(source, id) as unknown as CoordRow2;
  return { ...r };
};
const share = (db: DatabaseSync) => {
  for (const sql of SHARE_COORDS_SQLS) db.prepare(sql).run();
};
function applyGsi(db: DatabaseSync, source: string, triedAt: string, results: CoordResult[]): void {
  db.prepare(UPDATE_GSI_COORDS_SQL).run(source, triedAt, JSON.stringify(results.map(coordUpdateRow)));
}
const P = COORD_PRIORITY;
const coordTargets = (db: DatabaseSync) =>
  (db.prepare(COORD_TARGETS_SQL).all(SUUMO_SOURCE_ID, CHINTAI_SOURCE_ID, P.areaMin, P.roomsMin, P.saleMaxYen, P.rentMaxYen) as unknown as {
    external_id: string;
    kind: string;
    priority: number;
  }[]).map((r) => [r.external_id, r.kind, r.priority]);
const coordRemaining = (db: DatabaseSync) =>
  ({
    ...(db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(priority), 0) AS p FROM (${COORD_TARGETS_SQL})`)
      .get(SUUMO_SOURCE_ID, CHINTAI_SOURCE_ID, P.areaMin, P.roomsMin, P.saleMaxYen, P.rentMaxYen) as unknown as { n: number; p: number }),
  });
const gsiTargets = (db: DatabaseSync) =>
  (db.prepare(GSI_TARGETS_SQL).all(SUUMO_SOURCE_ID, CHINTAI_SOURCE_ID, P.areaMin, P.roomsMin, P.saleMaxYen, P.rentMaxYen) as unknown as {
    external_id: string;
    address: string;
    kind: string;
  }[]).map((r) => [r.external_id, r.kind, r.address]);

const ADDR = "福岡県福岡市東区原田４-16-36";

test("0010 のマイグレーション: 既存の座標は coord_source = 'suumo'・座標なしは NULL", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  for (const f of files.filter((x) => x < "0010")) applyMigration(db, f);
  for (const [id, lat] of [["1", 33.5], ["2", null]] as const) {
    db.prepare(
      `INSERT INTO listings (source, external_id, kind, first_seen, last_seen, current_price, lat, lng, coord_fetched_at)
       VALUES (?, ?, 'rent', '2026-09-01', '2026-09-01', 100000, ?, ?, '2026-10-31T00:00:00Z')`,
    ).run(CHINTAI_SOURCE_ID, id, lat, lat === null ? null : 130.4);
  }
  for (const f of files.filter((x) => x >= "0010")) applyMigration(db, f);
  assert.equal(readCoord2(db, "1").coord_source, "suumo");
  assert.equal(readCoord2(db, "2").coord_source, null);
  assert.equal(readCoord2(db, "1").gsi_tried_at, null);
});

test("使い回し: SUUMO 由来の座標は同じ建物の座標なし・仮座標の掲載へ写る（中古⇔賃貸・coord_fetched_at も）。空のキー・掲載終了・別の建物には写らない", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s-src", buildingName: "原田ハイツ", address: ADDR }),
    saleRecord({ externalId: "s-gsi", buildingName: " 原田ハイツ ", address: `${ADDR} ` }), // trim 後に一致
    saleRecord({ externalId: "s-noname", buildingName: "", address: ADDR }), // 建物名が空 → 写らない
    saleRecord({ externalId: "s-other", buildingName: "別の建物", address: ADDR }),
    saleRecord({ externalId: "s-gone", buildingName: "原田ハイツ", address: ADDR }),
  ]);
  upsertList(db, "2026-10-02", [rentRecord({ externalId: "r-same", buildingName: "原田ハイツ", address: ADDR })]);
  applyCoords(db, SUUMO_SOURCE_ID, "2026-10-31T11:00:00Z", [{ externalId: "s-src", kind: "sale", lat: 33.62416, lng: 130.44419 }]);
  applyGsi(db, SUUMO_SOURCE_ID, "2026-11-01T01:00:00Z", [{ externalId: "s-gsi", kind: "sale", lat: 33.623783, lng: 130.443893 }]);
  db.prepare("UPDATE listings SET delisted_on = '2026-10-30' WHERE external_id = 's-gone'").run();
  assert.equal(readCoord2(db, "s-src", SUUMO_SOURCE_ID).coord_source, "suumo");
  assert.equal(readCoord2(db, "s-gsi", SUUMO_SOURCE_ID).coord_source, "gsi");

  share(db);
  const copied = { lat: 33.62416, lng: 130.44419, coord_fetched_at: "2026-10-31T11:00:00Z", coord_source: "suumo" };
  assert.deepEqual({ ...readCoord2(db, "r-same"), gsi_tried_at: undefined }, { ...copied, gsi_tried_at: undefined }, "中古 → 賃貸");
  assert.deepEqual(readCoord2(db, "s-gsi", SUUMO_SOURCE_ID), { ...copied, gsi_tried_at: "2026-11-01T01:00:00Z" }, "仮座標は SUUMO 由来で上書き");
  for (const id of ["s-noname", "s-other", "s-gone"]) {
    assert.equal(readCoord2(db, id, SUUMO_SOURCE_ID).lat, null, id);
  }
  // 写された側はもう SUUMO に取りに行かない（同じ建物の他の掲載は targets に出ない）
  const ids = coordTargets(db).map((r) => r[0]);
  assert.ok(!ids.includes("r-same") && !ids.includes("s-gsi") && !ids.includes("s-src"), JSON.stringify(ids));
  assert.ok(ids.includes("s-noname") && ids.includes("s-other"));
});

test("使い回し: 国土地理院の仮座標は座標なしの掲載へだけ写る（coord_fetched_at は入れない = 後で SUUMO から取り直す）", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s-gsi", buildingName: "原田ハイツ", address: ADDR }),
    saleRecord({ externalId: "s-empty", buildingName: "原田ハイツ", address: ADDR }),
  ]);
  upsertList(db, "2026-10-02", [rentRecord({ externalId: "r-same", buildingName: "原田ハイツ", address: ADDR })]);
  applyGsi(db, SUUMO_SOURCE_ID, "2026-11-01T01:00:00Z", [{ externalId: "s-gsi", kind: "sale", lat: 33.623783, lng: 130.443893 }]);
  share(db);
  const gsi = { lat: 33.623783, lng: 130.443893, coord_fetched_at: null, coord_source: "gsi", gsi_tried_at: null };
  assert.deepEqual(readCoord2(db, "s-empty", SUUMO_SOURCE_ID), gsi);
  assert.deepEqual(readCoord2(db, "r-same"), gsi, "中古 → 賃貸にも");
  // SUUMO の targets には残る（建物で 1 件・賃貸が代表）
  assert.deepEqual(coordTargets(db), [["r-same", "rent", 1]]);
  // 国土地理院の targets からは外れる（lat がある）
  assert.deepEqual(gsiTargets(db), []);
});

test("SUUMO の targets: 同じ建物は 1 件（賃貸を代表に）・賃貸の建物が先・remaining は建物単位", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s-a1", buildingName: "A棟", address: "福岡市東区A" }),
    saleRecord({ externalId: "s-a2", buildingName: "A棟", address: "福岡市東区A", price: 60_000_000 }),
    saleRecord({ externalId: "s-b", buildingName: "B棟", address: "福岡市東区B" }),
    saleRecord({ externalId: "s-nokey1", buildingName: "C棟" }), // 住所が無い → 単独
    saleRecord({ externalId: "s-nokey2", buildingName: "C棟" }),
  ]);
  upsertList(db, "2026-10-05", [
    rentRecord({ externalId: "r-b", buildingName: "B棟", address: "福岡市東区B", floorPlan: "2LDK" }), // B 棟の代表は賃貸（条件外でも）
    rentRecord({ externalId: "r-d", buildingName: "D棟", address: "福岡市東区D" }),
  ]);
  assert.deepEqual(coordTargets(db), [
    ["r-b", "rent", 1], // 建物の中の 1 件（s-b）が条件に近いので建物として priority 1（r-d と同じ日に見えたので ID 順）
    ["r-d", "rent", 1],
    ["s-a1", "sale", 1],
    ["s-nokey1", "sale", 1],
    ["s-nokey2", "sale", 1],
  ]);
  assert.deepEqual(coordRemaining(db), { n: 5, p: 5 });
  // B 棟を SUUMO で取ったら（r-b）、同じ建物の中古 s-b も使い回しで埋まり、B 棟は出てこない
  applyCoords(db, CHINTAI_SOURCE_ID, "2026-11-01T02:00:00Z", [{ externalId: "r-b", kind: "rent", lat: 33.6, lng: 130.4 }]);
  share(db);
  assert.equal(readCoord2(db, "s-b", SUUMO_SOURCE_ID).coord_source, "suumo");
  assert.deepEqual(coordTargets(db).map((r) => r[0]), ["r-d", "s-a1", "s-nokey1", "s-nokey2"]);
  assert.deepEqual(coordRemaining(db), { n: 4, p: 4 });
});

test("国土地理院の仮座標は SUUMO の結果で上書きされ、SUUMO が読めなかった（null）ときは残る", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s1", buildingName: "原田ハイツ", address: ADDR }),
    saleRecord({ externalId: "s2", buildingName: "原田コーポ", address: ADDR }),
  ]);
  applyGsi(db, SUUMO_SOURCE_ID, "2026-11-01T01:00:00Z", [
    { externalId: "s1", kind: "sale", lat: 33.623783, lng: 130.443893 },
    { externalId: "s2", kind: "sale", lat: 33.623783, lng: 130.443893 },
  ]);
  assert.deepEqual(coordTargets(db).map((r) => r[0]), ["s1", "s2"], "仮座標があっても SUUMO の targets に残る（建物名が別なので 2 件）");
  applyCoords(db, SUUMO_SOURCE_ID, "2026-11-01T02:00:00Z", [
    { externalId: "s1", kind: "sale", lat: 33.62416, lng: 130.44419 },
    { externalId: "s2", kind: "sale", lat: null, lng: null },
  ]);
  assert.deepEqual(readCoord2(db, "s1", SUUMO_SOURCE_ID), {
    lat: 33.62416, lng: 130.44419, coord_fetched_at: "2026-11-01T02:00:00Z", coord_source: "suumo", gsi_tried_at: "2026-11-01T01:00:00Z",
  });
  assert.deepEqual(readCoord2(db, "s2", SUUMO_SOURCE_ID), {
    lat: 33.623783, lng: 130.443893, coord_fetched_at: "2026-11-01T02:00:00Z", coord_source: "gsi", gsi_tried_at: "2026-11-01T01:00:00Z",
  }, "SUUMO が null なら仮座標を消さない");
});

test("国土地理院の targets / results: 番地のある住所・座標なし・未試行だけ・同じ建物は 1 件。lat が NULL の行だけ入れ、gsi_tried_at は必ず入る", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [
    saleRecord({ externalId: "s-banchi", buildingName: "X", address: ADDR }),
    saleRecord({ externalId: "s-banchi2", buildingName: "X", address: ADDR }), // 同じ建物 → 1 件だけ
    saleRecord({ externalId: "s-zen", buildingName: "Y", address: "福岡県福岡市東区香椎浜２－５－１" }), // 全角ハイフン
    saleRecord({ externalId: "s-chome", buildingName: "Z", address: "福岡県福岡市東区原田４" }), // 丁目止まり
    saleRecord({ externalId: "s-has", buildingName: "W", address: "福岡県福岡市東区原田４-1-1" }), // SUUMO 済み
    saleRecord({ externalId: "s-gone", buildingName: "V", address: "福岡県福岡市東区原田４-2-2" }),
  ]);
  upsertList(db, "2026-10-02", [rentRecord({ externalId: "r-chome", address: "福岡県福岡市中央区平尾浄水町" })]);
  applyCoords(db, SUUMO_SOURCE_ID, "2026-10-31T11:00:00Z", [{ externalId: "s-has", kind: "sale", lat: 33.6, lng: 130.4 }]);
  db.prepare("UPDATE listings SET delisted_on = '2026-10-30' WHERE external_id = 's-gone'").run();
  assert.deepEqual(gsiTargets(db), [
    ["s-banchi", "sale", ADDR],
    ["s-zen", "sale", "福岡県福岡市東区香椎浜２－５－１"],
  ]);

  // 結果: s-banchi は採用、s-zen は採らなかった（null）。SUUMO 済みの s-has に来ても上書きしない
  applyGsi(db, SUUMO_SOURCE_ID, "2026-11-01T01:00:00Z", [
    { externalId: "s-banchi", kind: "sale", lat: 33.623783, lng: 130.443893 },
    { externalId: "s-zen", kind: "sale", lat: null, lng: null },
    { externalId: "s-has", kind: "sale", lat: 33.1, lng: 130.1 },
  ]);
  assert.deepEqual(readCoord2(db, "s-banchi", SUUMO_SOURCE_ID), {
    lat: 33.623783, lng: 130.443893, coord_fetched_at: null, coord_source: "gsi", gsi_tried_at: "2026-11-01T01:00:00Z",
  });
  assert.deepEqual(readCoord2(db, "s-zen", SUUMO_SOURCE_ID), {
    lat: null, lng: null, coord_fetched_at: null, coord_source: null, gsi_tried_at: "2026-11-01T01:00:00Z",
  }, "採らなくても試した印は入る");
  assert.deepEqual(readCoord2(db, "s-has", SUUMO_SOURCE_ID), {
    lat: 33.6, lng: 130.4, coord_fetched_at: "2026-10-31T11:00:00Z", coord_source: "suumo", gsi_tried_at: "2026-11-01T01:00:00Z",
  }, "SUUMO の座標は上書きしない");
  // 使い回しで s-banchi2 にも入り、targets は空になる（s-zen は試し済み）
  share(db);
  assert.equal(readCoord2(db, "s-banchi2", SUUMO_SOURCE_ID).coord_source, "gsi");
  assert.deepEqual(gsiTargets(db), []);
});

test("一覧の毎日の UPSERT は coord_source・gsi_tried_at を消さない", () => {
  const db = freshDb();
  upsertSale(db, "2026-10-01", [saleRecord({ externalId: "s1", address: ADDR })]);
  applyGsi(db, SUUMO_SOURCE_ID, "2026-11-01T01:00:00Z", [{ externalId: "s1", kind: "sale", lat: 33.623783, lng: 130.443893 }]);
  upsertSale(db, "2026-11-02", [saleRecord({ externalId: "s1", address: ADDR, price: 44_000_000 })]);
  assert.deepEqual(readCoord2(db, "s1", SUUMO_SOURCE_ID), {
    lat: 33.623783, lng: 130.443893, coord_fetched_at: null, coord_source: "gsi", gsi_tried_at: "2026-11-01T01:00:00Z",
  });
});

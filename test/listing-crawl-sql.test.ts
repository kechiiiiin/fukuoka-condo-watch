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
  detailUpdateRow,
  listingUpsertRow,
  UPDATE_DETAIL_SQL,
  UPSERT_LISTINGS_SQL,
} from "../src/listing-crawl-core.ts";
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

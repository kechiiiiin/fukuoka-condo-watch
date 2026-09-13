// Data source B（掲載情報 → 掲載日数・値下げ履歴）の差し込み口。
//
// - ListingSource … 「その日の全件を返す」単純な情報源（許諾フィード・CSV 等）。snapshotListings で取り込む
// - PagedListingSource … 検索結果をページ単位で取る情報源。src/listing-crawl.ts が D1 のカーソルで
//   複数回の cron に分けて取り、完走した回だけ「掲載終了」を付ける
//
// SUUMO（src/suumo-source.ts）は PagedListingSource。**私的・非商用の個人利用に限り、既定は無効**
// （LISTINGS_ENABLED。README「掲載情報（SUUMO）」）。規約で機械取得を禁じているサイト
// （アットホーム・不動産ジャパン・楽待・Yahoo!不動産）は実装しない。

import type { Env } from "./env";

export interface ListingRecord {
  externalId: string;
  kind: "sale" | "rent";
  wardCode?: string;
  districtName?: string;
  buildingName?: string;
  buildingYear?: number;
  builtMonth?: number;
  areaSqm?: number;
  floorPlan?: string;
  lineName?: string;
  stationName?: string;
  walkMinutes?: number;
  /** 駅までバス便（walkMinutes は入れない） */
  bus?: boolean;
  address?: string;
  url?: string;
  /** 売買は総額（円）、賃貸は月額賃料（円） */
  price: number;
}

export interface ListingSource {
  /** listings.source に入る ID（例: "partner-feed-x"） */
  readonly id: string;
  /** 利用の根拠（規約 URL・契約名・私的利用の範囲など）。根拠を書けないアダプタは作らないこと */
  readonly permission: string;
  /** その日に掲載中の全件を返す（ページングはアダプタ内で完結させる） */
  fetchActive(env: Env): Promise<ListingRecord[]>;
}

export interface CrawlTarget {
  /** 市区町村コード（5 桁） */
  areaCode: string;
  /** 情報源側のキー（SUUMO なら sc_<slug> の slug） */
  key: string;
}

export interface ParsedListPage {
  /** 検索全体のヒット件数。0 件ページは zeroHits=true・totalHits=null */
  totalHits: number | null;
  zeroHits: boolean;
  maxPageLinked: number | null;
  records: ListingRecord[];
  /** 価格が読めず捨てた件数 */
  skipped: number;
}

export interface PagedListingSource extends ListingSource {
  readonly pageSize: number;
  targets(): CrawlTarget[];
  pageUrl(target: CrawlTarget, page: number): string;
  parsePage(html: string, target: CrawlTarget): ParsedListPage;
  /** 止まるべき応答なら種別（"http_429" 等）、問題なければ null */
  detectBlock(status: number, html: string): string | null;
}

/** 「その日の全件」型の許諾済み情報源。現在は空（SUUMO はページ型なので listing-crawl.ts 側） */
export const ADAPTERS: ListingSource[] = [];

/**
 * 1 情報源ぶんの日次スナップショットを取り込む（ListingSource 用）。
 * - 初出: first_seen = today、価格履歴に 1 行
 * - 継続: last_seen 更新。価格が変われば履歴に 1 行
 * - 消滅: 今日見えなかった掲載中の物件に delisted_on = today
 * 同じ日に何度走っても結果は同じ（冪等）。
 */
export async function snapshotListings(env: Env, source: ListingSource, today: string): Promise<void> {
  const records = await source.fetchActive(env);
  const db = env.DB;
  const existing = await db
    .prepare("SELECT external_id, current_price FROM listings WHERE source = ? AND delisted_on IS NULL")
    .bind(source.id)
    .all<{ external_id: string; current_price: number | null }>();
  const active = new Map(existing.results.map((r) => [r.external_id, r.current_price]));
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  let newCount = 0;

  for (const r of records) {
    seen.add(r.externalId);
    const known = active.has(r.externalId);
    if (!known) newCount++;
    stmts.push(
      db
        .prepare(
          `INSERT INTO listings (source, external_id, kind, ward_code, district_name, building_name, building_year,
             area_sqm, floor_plan, station_name, walk_minutes, url, first_seen, last_seen, current_price, delisted_on)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
           ON CONFLICT (source, external_id) DO UPDATE SET
             last_seen = excluded.last_seen, current_price = excluded.current_price, delisted_on = NULL`,
        )
        .bind(
          source.id, r.externalId, r.kind, r.wardCode ?? null, r.districtName ?? null, r.buildingName ?? null,
          r.buildingYear ?? null, r.areaSqm ?? null, r.floorPlan ?? null, r.stationName ?? null,
          r.walkMinutes ?? null, r.url ?? null, today, today, r.price,
        ),
    );
    if (!known || active.get(r.externalId) !== r.price) {
      stmts.push(
        db
          .prepare("INSERT OR REPLACE INTO listing_price_history (source, external_id, observed_on, price) VALUES (?,?,?,?)")
          .bind(source.id, r.externalId, today, r.price),
      );
    }
  }

  let goneCount = 0;
  for (const id of active.keys()) {
    if (seen.has(id)) continue;
    goneCount++;
    stmts.push(
      db.prepare("UPDATE listings SET delisted_on = ? WHERE source = ? AND external_id = ?").bind(today, source.id, id),
    );
  }
  stmts.push(
    db
      .prepare(
        "INSERT OR REPLACE INTO listing_snapshots (source, snapshot_on, seen_count, new_count, gone_count) VALUES (?,?,?,?,?)",
      )
      .bind(source.id, today, records.length, newCount, goneCount),
  );
  await db.batch(stmts);
}

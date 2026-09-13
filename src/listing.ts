// Data source B（掲載情報 → 掲載日数・値下げ履歴）の差し込み口。
//
// ⚠️ 主要ポータル（SUUMO / LIFULL HOME'S / at home / 不動産ジャパン / Yahoo!不動産）は
// 利用規約で機械的な取得を禁じている、または許諾が明確でないため、実装していない（README 参照）。
// 許諾された情報源（公式 API・データ提供契約・自分で入手した CSV 等）が見つかったら、
// この interface を実装して ADAPTERS に登録するだけで、日次スナップショットが回るようにしてある。

import type { Env } from "./env";

export interface ListingRecord {
  externalId: string;
  kind: "sale" | "rent";
  wardCode?: string;
  districtName?: string;
  buildingName?: string;
  buildingYear?: number;
  areaSqm?: number;
  floorPlan?: string;
  stationName?: string;
  walkMinutes?: number;
  url?: string;
  /** 売買は総額（円）、賃貸は月額賃料（円） */
  price: number;
}

export interface ListingSource {
  /** listings.source に入る ID（例: "partner-feed-x"） */
  readonly id: string;
  /** 利用許諾の根拠（規約 URL・契約名など）。無いアダプタは登録しないこと */
  readonly permission: string;
  /** その日に掲載中の全件を返す（ページングはアダプタ内で完結させる） */
  fetchActive(env: Env): Promise<ListingRecord[]>;
}

/** 許諾済みの情報源だけを登録する。現在は空。 */
export const ADAPTERS: ListingSource[] = [];

/**
 * 1 情報源ぶんの日次スナップショットを取り込む。
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

// 「職場・学校へ乗り換えなしで行けるバス停まで歩けるか」の判定（/listings/picks の「バスで職場・学校へ直通」と、
// カードの「職場へ直通: ◯◯ 徒歩N分（13番）」）。D1 に触らない純粋な部品（test/bus-access.test.ts）。
//
// バス停は src/data/bus-routes.json（scripts/collect-nnr-routes.ts が西鉄の時刻表から集めた。このファイルからは書き換えない）の
// stops[]（name・lat・lng・dests・numbers・higashiStops）。座標の無い停留所は使わない。
// 系統番号は routes[]（direction = "to_dest"）から行先別に起こす（stops[].numbers は職場行き・学校行きの合算なので、
// 「職場へ直通（13番）」に学校行きの番号が混ざらないように）。routes から取れなければ stops[].numbers に戻す。
//
// 計算量: 物件（数千）× 停留所（約600）。停留所を緯度経度の格子（1 マス ≒ 0.005°・約 450〜550m）に入れておき、
// 物件の周り 3×3 マスだけを見る（1 物件あたり数か所〜数十か所の距離計算で済む）。格子は初回に 1 回だけ作る。

import busRoutes from "./data/bus-routes.json";

/**
 * 「徒歩 5 分」の定義（置き場はここ 1 か所）。
 * 根拠: SUUMO の「徒歩◯分」は**道のり 80m = 1 分**（不動産の表示に関する公正競争規約の基準）。
 * ここで測れるのは建物とバス停の**直線距離**で、道のりは直線より長くなるので、直線では 2 割控えめに 64m = 1 分とみなす。
 * → 5 分 = 直線 320m。分の表示は 直線距離 ÷ 64m を切り上げる（320m ちょうどで 5 分）。
 */
export const BUS_WALK_M_PER_MIN = 64;
export const BUS_WALK_MAX_MIN = 5;
export const BUS_WALK_MAX_M = BUS_WALK_M_PER_MIN * BUS_WALK_MAX_MIN;

/** 行先。gion = 職場（祇園町）/ higashi = 学校（東光二丁目ほか） */
export type BusDest = "gion" | "higashi";
export const BUS_DESTS: readonly BusDest[] = ["gion", "higashi"];

/** 判定に使う停留所 1 つ（行先ごとに分けてある。両方へ行けるバス停は 2 件になる） */
export interface DirectStop {
  name: string;
  lat: number;
  lng: number;
  dest: BusDest;
  /** その行先へ直通する系統番号 */
  numbers: string[];
  /** 学校行きのとき、降りるバス停（bus-routes.json の higashiStops。無ければ空） */
  alightAt: string[];
}

/** 物件から見た、行先 1 つぶんの最寄りの直通バス停 */
export interface BusHit {
  name: string;
  /** 直線距離（m・整数に丸め） */
  meters: number;
  /** 徒歩分（直線距離 ÷ 64m を切り上げ。最低 1 分） */
  minutes: number;
  numbers: string[];
  alightAt: string[];
}

/** 行先ごとの最寄り（徒歩 5 分以内に無ければ null） */
export type BusAccess = Record<BusDest, BusHit | null>;

/** src/data/bus-routes.json のうち、ここで読む項目 */
export interface BusRoutesInput {
  routes?: { dest: string; number: string; direction: string; stops: { name: string }[]; destIndex: number }[];
  stops: { name: string; lat: number | null; lng: number | null; dests: string[]; numbers: string[]; higashiStops?: string[] }[];
}

const isDest = (d: string): d is BusDest => d === "gion" || d === "higashi";

/** bus-routes.json → 行先ごとの直通バス停（座標の無いものは除く） */
export function directStopsFrom(raw: BusRoutesInput): DirectStop[] {
  // 行先ごと・停留所名ごとの系統番号（乗る側 = 目的のバス停より手前の停留所だけ）
  const byDest = new Map<string, Set<string>>();
  for (const r of raw.routes ?? []) {
    if (r.direction !== "to_dest" || !isDest(r.dest)) continue;
    for (const s of r.stops.slice(0, Math.max(0, r.destIndex))) {
      const k = `${r.dest}\t${s.name}`;
      let set = byDest.get(k);
      if (!set) byDest.set(k, (set = new Set()));
      set.add(r.number);
    }
  }
  const out: DirectStop[] = [];
  for (const s of raw.stops) {
    if (s.lat === null || s.lng === null || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    for (const d of s.dests) {
      if (!isDest(d)) continue;
      const fromRoutes = byDest.get(`${d}\t${s.name}`);
      out.push({
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        dest: d,
        numbers: fromRoutes && fromRoutes.size > 0 ? sortNumbers([...fromRoutes]) : sortNumbers(s.numbers),
        alightAt: d === "higashi" ? (s.higashiStops ?? []) : [],
      });
    }
  }
  return out;
}

/** 系統番号を数字の順に（"3" < "13" < "39B" < "400"） */
function sortNumbers(ns: string[]): string[] {
  const lead = (s: string) => {
    const m = /^(\d+)/.exec(s);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return [...new Set(ns)].sort((a, b) => lead(a) - lead(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const EARTH_R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** 2 点間の直線距離（m・大円距離） */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 直線距離 → 徒歩分（÷ 64m を切り上げ。0m でも 1 分と出す） */
export function walkMinutesFromMeters(m: number): number {
  return Math.max(1, Math.ceil(m / BUS_WALK_M_PER_MIN - 1e-9));
}

/** 格子 1 マスの大きさ（度）。BUS_WALK_MAX_M（320m）より大きいので、周り 3×3 マスを見れば取りこぼさない */
const CELL_DEG = 0.005;
const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

/** 停留所の格子（物件ごとに全停留所と比べないため） */
export class BusStopIndex {
  private readonly cells = new Map<string, DirectStop[]>();
  /** 座標のある直通バス停の「場所」の数（同じ名前・同じ座標で職場・学校の両方に行くものは 1 か所と数える） */
  readonly placeCount: number;

  constructor(readonly stops: readonly DirectStop[]) {
    const places = new Set<string>();
    for (const s of stops) {
      const k = cellOf(s.lat, s.lng);
      const arr = this.cells.get(k);
      if (arr) arr.push(s);
      else this.cells.set(k, [s]);
      places.add(`${s.name}\t${s.lat}\t${s.lng}`);
    }
    this.placeCount = places.size;
  }

  /** 物件の座標 → 行先ごとの最寄りの直通バス停（徒歩 5 分 = 直線 320m 以内だけ） */
  nearest(lat: number, lng: number, maxM = BUS_WALK_MAX_M): BusAccess {
    const best: Record<BusDest, { s: DirectStop; m: number } | null> = { gion: null, higashi: null };
    const ci = Math.floor(lat / CELL_DEG);
    const cj = Math.floor(lng / CELL_DEG);
    // 緯度 1° ≒ 111km・経度 1° ≒ 111km × cos(緯度)。先に箱で落としてから距離を測る
    const dLat = maxM / 111_000;
    const dLng = maxM / (111_000 * Math.cos(rad(lat)));
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const s of this.cells.get(`${i}:${j}`) ?? []) {
          if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lng - lng) > dLng) continue;
          const m = distanceM(lat, lng, s.lat, s.lng);
          if (m > maxM) continue;
          const cur = best[s.dest];
          if (!cur || m < cur.m) best[s.dest] = { s, m };
        }
      }
    }
    const hit = (b: { s: DirectStop; m: number } | null): BusHit | null =>
      b
        ? { name: b.s.name, meters: Math.round(b.m), minutes: walkMinutesFromMeters(b.m), numbers: b.s.numbers, alightAt: b.s.alightAt }
        : null;
    return { gion: hit(best.gion), higashi: hit(best.higashi) };
  }

  /** 職場・学校のどちらかへ徒歩 5 分以内で直通できるか */
  hasAny(lat: number, lng: number): boolean {
    const a = this.nearest(lat, lng);
    return a.gion !== null || a.higashi !== null;
  }
}

let shared: BusStopIndex | null = null;
/** src/data/bus-routes.json から作った格子（初回に 1 回だけ作り、以後は使い回す） */
export function busStopIndex(): BusStopIndex {
  if (!shared) shared = new BusStopIndex(directStopsFrom(busRoutes as unknown as BusRoutesInput));
  return shared;
}

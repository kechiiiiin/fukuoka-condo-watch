// 掲載情報の集計（src/listing-metrics.ts）のうち D1 に触らない純粋関数。
// scoring.ts と同様、test/listing-metrics.test.ts から直接テストする（tsconfig.test.json の include に入れている）。

import { MIN_RECENT_SALES } from "./scoring";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

const dayMs = 86_400_000;
export const dayNum = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
export function addDays(d: string, n: number): string {
  return new Date((dayNum(d) + n) * dayMs).toISOString().slice(0, 10);
}

/**
 * 売出/成約の比。件数が薄いと分母（成約㎡単価の中央値）が数件で振り回されるので、
 * 市区町村の売りやすさと同じ最低件数（MIN_RECENT_SALES）未満なら比を出さない（null）。
 */
export function askToTxRatio(askUnitMedian: number | null, txUnitMedian: number | null, txN: number): number | null {
  if (askUnitMedian === null || txUnitMedian === null || txN < MIN_RECENT_SALES) return null;
  return Math.round((100 * askUnitMedian) / txUnitMedian) / 100;
}

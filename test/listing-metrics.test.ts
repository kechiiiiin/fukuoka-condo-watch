// 掲載情報の集計（src/listing-metrics.ts が使う src/listing-scoring.ts）のうち D1 に触らない純粋関数のテスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, askToTxRatio, median } from "../src/listing-scoring.ts";
import { MIN_RECENT_SALES } from "../src/scoring.ts";

test("中央値: 空配列は null、偶数件は中央2件の平均", () => {
  assert.equal(median([]), null);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([5, 1, 3]), 3);
});

test("日付の加算（JST日付文字列）", () => {
  assert.equal(addDays("2026-09-14", 1), "2026-09-15");
  assert.equal(addDays("2026-09-14", -14), "2026-08-31");
});

test("売出/成約の比: 件数が MIN_RECENT_SALES（20件）未満なら比を出さない", () => {
  assert.equal(MIN_RECENT_SALES, 20);
  // 宇美町のような薄い成約件数（4件）では、売出/成約の㎡単価がどれだけ近くても比を出さない
  assert.equal(askToTxRatio(300000, 290000, 4), null);
  assert.equal(askToTxRatio(300000, 290000, 19), null);
});

test("売出/成約の比: 閾値以上なら比を計算する（小数第2位で丸め）", () => {
  assert.equal(askToTxRatio(310000, 300000, 20), 1.03);
  assert.equal(askToTxRatio(300000, 300000, 100), 1);
});

test("売出/成約の比: 売出・成約どちらかの中央値が無ければ null", () => {
  assert.equal(askToTxRatio(null, 300000, 100), null);
  assert.equal(askToTxRatio(300000, null, 100), null);
});

// 掲載クロールの共通部品（src/listing-crawl-core.ts）: LISTINGS_ENABLED の解釈・間隔の下限・応答の振り分け・取り込み要求の検証
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFakePage } from "../scripts/fake-suumo-server.ts";
import { classifyResponse, CRAWL, crawlSettings, listingsMode, parseIngestRequest } from "../src/listing-crawl-core.ts";
import { SuumoSource } from "../src/suumo-source.ts";

test("LISTINGS_ENABLED の解釈（不明な値は off に倒す）", () => {
  assert.equal(listingsMode({}), "off");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "" }), "off");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "off" }), "off");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "yes" }), "off");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "on" }), "on");
  assert.equal(listingsMode({ LISTINGS_ENABLED: " TRUE " }), "on");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "1" }), "on");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "external" }), "external");
  assert.equal(listingsMode({ LISTINGS_ENABLED: "External" }), "external");
});

test("本番（suumo.jp）は 30 秒未満にできない・偽サーバ相手だけ詰められる", () => {
  assert.equal(CRAWL.floorIntervalMs, 30_000);
  assert.equal(crawlSettings({}).intervalMs, 30_000);
  assert.equal(crawlSettings({ LISTINGS_MIN_INTERVAL_MS: "0" }).intervalMs, 30_000);
  assert.equal(crawlSettings({ LISTINGS_MIN_INTERVAL_MS: "20000" }).intervalMs, 30_000);
  assert.equal(crawlSettings({ LISTINGS_MIN_INTERVAL_MS: "45000" }).intervalMs, 45_000);
  // localhost 以外の SUUMO_ORIGIN は無視（suumo.jp 扱い）
  const remote = crawlSettings({ SUUMO_ORIGIN: "https://evil.example.com", LISTINGS_MIN_INTERVAL_MS: "0" });
  assert.equal(remote.origin, undefined);
  assert.equal(remote.intervalMs, 30_000);
  const local = crawlSettings({ SUUMO_ORIGIN: "http://127.0.0.1:8790", LISTINGS_MIN_INTERVAL_MS: "0", LISTINGS_TODAY_OVERRIDE: "2026-01-02" });
  assert.equal(local.origin, "http://127.0.0.1:8790");
  assert.equal(local.intervalMs, 0);
  assert.equal(local.todayOverride, "2026-01-02");
  assert.equal(crawlSettings({ LISTINGS_TODAY_OVERRIDE: "2026-01-02" }).todayOverride, null);
});

test("応答の振り分け（止まる・ページ消滅・失敗・解析）", () => {
  const src = new SuumoSource({ origin: "http://127.0.0.1:8790" });
  const t = { areaCode: "40217", key: "chikushino" };
  const url = src.pageUrl(t, 1);
  assert.deepEqual(classifyResponse(src, t, 1, url, 429, "too many", null), {
    kind: "blocked",
    block: "http_429",
    status: 429,
    location: null,
    bodyHead: "too many",
  });
  assert.equal(classifyResponse(src, t, 1, url, 503, "", null).kind, "blocked");
  assert.equal(classifyResponse(src, t, 1, url, 200, "<html>maintenance</html>", null).kind, "blocked");
  assert.deepEqual(classifyResponse(src, t, 2, url, 404, "", null), { kind: "gone", status: 404 });
  assert.deepEqual(classifyResponse(src, t, 1, url, 404, "", null), { kind: "http_error", status: 404 });
  const page = renderFakePage("chikushino", 1, 1);
  const o = classifyResponse(src, t, 1, url, page.status, page.html, null);
  assert.equal(o.kind, "parsed");
  if (o.kind === "parsed") {
    assert.ok(o.page.records.length > 0);
    // 解析結果はそのまま取り込み要求として通る（Mac → Worker の往復で形が崩れない）
    const req = parseIngestRequest(JSON.parse(JSON.stringify({
      op: "page", runId: "suumo:ms-chuko:2026-09-22", areaCode: "40217", page: 1, url, fetchedAt: new Date().toISOString(), outcome: o,
    })));
    assert.equal(req.op, "page");
    if (req.op === "page") assert.deepEqual(req.outcome, o);
  }
});

test("取り込み要求の検証（不正な形は弾く）", () => {
  assert.deepEqual(parseIngestRequest({ op: "begin" }), { op: "begin" });
  const base = {
    op: "page",
    runId: "suumo:ms-chuko:2026-09-22",
    areaCode: "40131",
    page: 1,
    url: "https://suumo.jp/ms/chuko/fukuoka/sc_fukuokashihigashi/",
    fetchedAt: "2026-09-22T16:00:00.000Z",
    outcome: { kind: "http_error", status: 500 },
  };
  assert.equal(parseIngestRequest(base).op, "page");
  const bad = (patch: Record<string, unknown>) => assert.throws(() => parseIngestRequest({ ...base, ...patch }));
  bad({ op: "drop" });
  bad({ runId: "x; DROP TABLE listings" });
  bad({ areaCode: "4013" });
  bad({ page: 0 });
  bad({ page: 1.5 });
  bad({ url: "javascript:alert(1)" });
  bad({ fetchedAt: "yesterday" });
  bad({ outcome: { kind: "blocked", block: "Bad Kind!", status: 429 } });
  bad({ outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: null, skipped: 0, records: [{ externalId: "1", kind: "rent", price: 1 }] } } });
  bad({ outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: null, skipped: 0, records: [{ externalId: "1", kind: "sale", price: -1 }] } } });
  bad({ outcome: { kind: "parsed", page: { totalHits: 1, zeroHits: false, maxPageLinked: null, skipped: 0, records: [{ externalId: "1", kind: "sale", price: 1, wardCode: "abc" }] } } });
  assert.throws(() => parseIngestRequest(null));
  assert.throws(() => parseIngestRequest([]));
  const end = parseIngestRequest({ op: "end", runId: base.runId, summary: { status: "complete", pages: 231 } });
  assert.deepEqual(end, { op: "end", runId: base.runId, summary: { status: "complete", pages: 231, detail: undefined } });
});

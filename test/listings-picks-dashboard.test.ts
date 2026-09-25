// /listings/picks の画面（src/listings-picks-dashboard.ts）のスモークテスト。
// ビルドが通っても画面は壊れうるので、埋め込みスクリプトを小さな DOM スタブの上で**実際に実行**して、
// 売買・賃貸それぞれでカードが描けることまで確かめる（feedback-see-the-screen-before-shipping）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderListingsPicksDashboard } from "../src/listings-picks-dashboard.ts";

// ---- 最小の DOM スタブ（画面のスクリプトが使う分だけ） ----
class El {
  className = "";
  textContent = "";
  innerHTML = "";
  value = "";
  checked = false;
  placeholder = "";
  step = "";
  label = "";
  selected = false;
  readonly children: El[] = [];
  removed = false;
  firstChild: { nodeValue: string };
  constructor(readonly tag: string, readonly id = "") {
    this.firstChild = { nodeValue: "" };
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  remove() {
    this.removed = true;
  }
  addEventListener() {
    /* 送信はテストから直接呼ぶ */
  }
  get options(): El[] {
    return this.children.flatMap((c) => (c.tag === "optgroup" ? c.children : [c]));
  }
  get selectedOptions(): El[] {
    return this.options.filter((o) => o.selected);
  }
}

interface Harness {
  ids: Map<string, El>;
  requestedUrls: string[];
  respond: (payload: unknown) => void;
  run: () => void;
}

function harness(search: string, payload: () => unknown): Harness {
  const ids = new Map<string, El>();
  const form = new El("form", "filters") as El & Record<string, El>;
  for (const name of ["pmax", "amin", "plan", "age", "walk", "sort", "dk", "bus", "pets", "fresh"]) {
    (form as unknown as Record<string, El>)[name] = new El("input", name);
  }
  for (const id of [
    "tab-sale", "tab-rent", "title", "defaults-text", "lb-pmax", "lb-sort", "opt-retention", "lb-pets",
    "muni-select", "asof", "notices", "coverage", "count", "cards", "cards-section", "footer",
  ]) {
    ids.set(id, new El("div", id));
  }
  ids.set("filters", form);
  const requestedUrls: string[] = [];
  let resolvePayload: (v: unknown) => void = () => {};
  const done = new Promise((r) => (resolvePayload = r));

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    title: "",
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (tag: string) => new El(tag),
  };
  g.location = { search };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  g.fetch = (url: string) => {
    requestedUrls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload()) });
  };

  const html = renderListingsPicksDashboard();
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script && script[1], "埋め込みスクリプトが見つからない");
  return {
    ids,
    requestedUrls,
    respond: resolvePayload,
    run: () => {
      new Function(script[1]!)();
      void done;
    },
  };
}

const CARD = {
  buildingName: "架空ハイツ",
  wardCode: "40133",
  wardName: "中央区",
  districtName: "大宮",
  address: "福岡県福岡市中央区大宮２",
  areaSqm: 72.5,
  floorPlan: "3LDK",
  buildingYear: 2015,
  builtMonth: 3,
  lineName: "西鉄天神大牟田線",
  stationName: "薬院",
  walkMinutes: 5,
  bus: false,
  count: 2,
  minPrice: 125000,
  maxPrice: 128000,
  unitPriceMin: 1724,
  unitPriceMax: 1766,
  priceCutCountMax: 0,
  relistedCountMax: 0,
  earliestFirstSeen: "2026-09-20",
  latestFirstSeen: "2026-09-22",
  isFresh: true,
  urls: ["https://suumo.jp/chintai/jnc_000012345678/"],
  sellScore: null,
  sellStatusLabel: null,
  rentScore: 72,
  rentStatusLabel: null,
  askToTx: null,
  askToTxStatus: null,
  retention: null,
  adminFeeMin: 5000,
  adminFeeMax: 8000,
  depositMin: 125000,
  keyMoneyMin: 0,
  petsAllowed: true,
  listedOn: null,
};

const PAYLOAD = (kind: string) => ({
  today: "2026-09-26",
  kind,
  filters: { sort: "newest" },
  retentionBasis: { cat: "contract", label: "成約価格", latestQuarter: null, recentFrom: null, priorFrom: null, priorTo: null },
  matchedListings: 2,
  groups: 1,
  coverage: { latestRun: { crawlDate: "2026-09-26", status: "complete" }, lastCompleteAt: "2026-09-26T00:00:00Z", areas: [] },
  notes: ["テストの注記"],
  items: [CARD],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("画面（売買）: スクリプトが動いてカードが描ける・タブは売買が選択・ペットのトグルは隠す", async () => {
  const h = harness("", () => PAYLOAD("sale"));
  h.run();
  await flush();
  assert.equal(h.ids.get("tab-sale")!.className, "on");
  assert.equal(h.ids.get("tab-rent")!.className, "");
  assert.ok(h.ids.get("title")!.textContent.includes("条件に合う新着"));
  assert.ok(h.ids.get("defaults-text")!.textContent.includes("4,800万円以下"));
  assert.equal(h.ids.get("lb-pets")!.className, "checks hidden", "売買ではペットのトグルを出さない");
  assert.equal(h.ids.get("opt-retention")!.removed, false, "売買では価格維持の並べ替えを残す");
  assert.equal(h.requestedUrls.length, 1);
  assert.ok(!h.requestedUrls[0]!.includes("kind=rent"));
  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes("架空ハイツ"), "カードが描けている");
  assert.ok(cards.includes("㎡単価"), "売買のカード");
  assert.ok(!cards.includes("ペット相談可"));
});

test("画面（賃貸）: ?kind=rent でタブ・既定条件・賃料/管理費/敷礼/ペット/掲載日が出る", async () => {
  const h = harness("?kind=rent", () => PAYLOAD("rent"));
  h.run();
  await flush();
  assert.equal(h.ids.get("tab-rent")!.className, "on");
  assert.equal(h.ids.get("tab-sale")!.className, "");
  assert.ok(h.ids.get("title")!.textContent.includes("賃貸"));
  const defaults = h.ids.get("defaults-text")!.textContent;
  for (const s of ["家賃 15万円以下", "70㎡以上", "3LDK以上", "築25年以内"]) assert.ok(defaults.includes(s), `既定条件に「${s}」`);
  assert.equal(h.ids.get("lb-pets")!.className, "", "賃貸ではペットのトグルを出す");
  assert.equal(h.ids.get("opt-retention")!.removed, true, "賃貸では価格維持の並べ替えを消す");
  assert.equal(h.requestedUrls.length, 1);
  assert.ok(h.requestedUrls[0]!.includes("kind=rent"));

  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes("125,000円〜128,000円"), "賃料の幅");
  assert.ok(cards.includes("管理費 5,000円〜8,000円"));
  assert.ok(cards.includes("敷金 125,000円"));
  assert.ok(cards.includes("礼金 0円"));
  assert.ok(cards.includes("ペット相談可"));
  assert.ok(cards.includes("初めて見た日 2026-09-20"), "SUUMO の掲載日は取れないので「初めて見た日」と出す");
  assert.ok(!cards.includes("情報公開日"));
  assert.ok(cards.includes("貸しやすさ"));
  assert.ok(!cards.includes("価格維持"), "価格維持は売買の指標なので出さない");
  assert.ok(!cards.includes("㎡単価"));
  assert.ok(h.ids.get("footer")!.innerHTML.includes("賃貸掲載"), "出典の注記も賃貸向けに差し替わる");
});

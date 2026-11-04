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
  readonly handlers: Record<string, () => void> = {};
  addEventListener(type: string, fn: () => void) {
    this.handlers[type] = fn; /* 送信・クリックはテストから直接呼ぶ */
  }
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
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

function harness(search: string, payload: () => unknown, initialStore: Record<string, string> = {}): Harness {
  const ids = new Map<string, El>();
  const form = new El("form", "filters") as El & Record<string, El>;
  for (const name of ["pmax", "amin", "plan", "age", "walk", "tatami", "floors", "sort", "dk", "bus", "pets", "mais", "fresh"]) {
    (form as unknown as Record<string, El>)[name] = new El("input", name);
  }
  for (const id of [
    "tab-sale", "tab-rent", "title", "defaults-text", "lb-pmax", "lb-sort", "opt-retention", "lb-pets",
    "lb-mais", "lb-tatami", "lb-floors", "area-btn-airport", "area-btn-ijiri", "area-btn-minamifukuoka", "area-btn-bus", "bus-note",
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
  const store = new Map<string, string>(Object.entries(initialStore));
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
  // 0007（2026-09-26）: 階数は情報として出すだけ・メゾネット / LDK 畳数は既定の絞り込みに使う
  buildingFloors: 8,
  roomFloorMin: 4,
  roomFloorMax: 4,
  maisonette: false,
  ldkTatami: 16.4,
  detailFetched: true,
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

test("画面: メゾネット除外のチェックボックスは既定 OFF（2026-10-05〜。ペット相談可は既定 ON のまま）", () => {
  const html = renderListingsPicksDashboard();
  assert.match(html, /<label class="checks" id="lb-mais"><input type="checkbox" name="mais" value="1">/, "メゾネットのチェックボックスに checked を付けない");
  assert.doesNotMatch(
    html.match(/id="lb-mais"[^<]*<input[^>]*>/)![0],
    /checked/,
    "メゾネットのチェックボックス自体には checked が付いていない",
  );
  assert.match(html, /<label class="checks" id="lb-pets"><input type="checkbox" name="pets" value="1" checked>/, "ペット相談可は既定 ON のまま");
});

test("画面（売買）: ?kind=sale でカードが描ける・タブは売買が選択・ペットのトグルは隠す", async () => {
  const h = harness("?kind=sale", () => PAYLOAD("sale"));
  h.run();
  await flush();
  assert.equal(h.ids.get("tab-sale")!.className, "on");
  assert.equal(h.ids.get("tab-rent")!.className, "");
  assert.ok(h.ids.get("title")!.textContent.includes("条件に合う新着"));
  assert.ok(h.ids.get("defaults-text")!.textContent.includes("4,800万円以下"));
  assert.equal(h.ids.get("lb-pets")!.className, "checks hidden", "売買ではペットのトグルを出さない");
  assert.equal(h.ids.get("opt-retention")!.removed, false, "売買では価格維持の並べ替えを残す");
  assert.equal(h.requestedUrls.length, 1);
  assert.ok(h.requestedUrls[0]!.includes("kind=sale"));
  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes("架空ハイツ"), "カードが描けている");
  assert.ok(cards.includes("㎡単価"), "売買のカード");
  assert.ok(!cards.includes("ペット相談可"));
});

test("画面（賃貸・既定）: 引数なしで賃貸タブ・既定条件・賃料/管理費/敷礼/ペット/掲載日が出る", async () => {
  const h = harness("", () => PAYLOAD("rent"));
  h.run();
  await flush();
  assert.equal(h.ids.get("tab-rent")!.className, "on");
  assert.equal(h.ids.get("tab-sale")!.className, "");
  assert.ok(h.ids.get("title")!.textContent.includes("賃貸"));
  const defaults = h.ids.get("defaults-text")!.textContent;
  for (const s of ["家賃 15万円以下", "70㎡以上", "3LDK以上", "築25年以内", "LDK 15畳以上", "建物の階数では絞りません"]) {
    assert.ok(defaults.includes(s), `既定条件に「${s}」`);
  }
  assert.ok(defaults.includes("メゾネットも含みます"), "2026-10-05〜 既定ではメゾネットを除かない旨を出す");
  assert.ok(!defaults.includes("メゾネットでない"), "既定条件の説明文から外した（除かなくなったため）");
  assert.equal(h.ids.get("lb-pets")!.className, "", "賃貸ではペットのトグルを出す");
  assert.equal(h.ids.get("lb-mais")!.className, "", "賃貸ではメゾネット除外のトグルを出す");
  assert.equal(h.ids.get("lb-tatami")!.className, "", "賃貸では LDK 畳数の入力を出す");
  assert.equal(h.ids.get("lb-floors")!.className, "", "賃貸では建物の階数の入力を出す（既定は指定なし）");
  assert.equal(h.ids.get("opt-retention")!.removed, true, "賃貸では価格維持の並べ替えを消す");
  assert.equal(h.requestedUrls.length, 1);
  assert.ok(!h.requestedUrls[0]!.includes("kind=sale"), "既定は賃貸なので kind は付けない");

  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes("125,000円〜128,000円"), "賃料の幅");
  assert.ok(cards.includes("管理費 5,000円〜8,000円"));
  assert.ok(cards.includes("敷金 125,000円"));
  assert.ok(cards.includes("礼金 0円"));
  assert.ok(cards.includes("ペット相談可"));
  // 0007 で足した 4 項目（建物階数・部屋の階・メゾネット可否・LDK 畳数）がカードに出る
  assert.ok(cards.includes("8階建"), "建物の階数");
  assert.ok(cards.includes("4階"), "部屋の階");
  // 0008: メゾネットは二値。0 のカードにはバッジを出さない（「メゾネット 不明」は廃止）
  assert.ok(!cards.includes("メゾネット"), "メゾネットでない部屋にはバッジを出さない");
  assert.ok(cards.includes("LDK 16.4畳"), "LDK の畳数");
  assert.ok(cards.includes("初めて見た日 2026-09-20"), "SUUMO の掲載日は取れないので「初めて見た日」と出す");
  assert.ok(!cards.includes("情報公開日"));
  assert.ok(cards.includes("貸しやすさ"));
  assert.ok(!cards.includes("価格維持"), "価格維持は売買の指標なので出さない");
  assert.ok(!cards.includes("㎡単価"));
  assert.ok(h.ids.get("footer")!.innerHTML.includes("賃貸掲載"), "出典の注記も賃貸向けに差し替わる");
});

// 0008（2026-09-27）: maisonette は 0/1 の二値。1 のときだけ警告色のバッジを出す
test("画面（賃貸）: メゾネットの部屋にはバッジが出る", async () => {
  const h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, maisonette: true }] }));
  h.run();
  await flush();
  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes('<span class="badge warnbadge">メゾネット</span>'), "メゾネットのバッジ");
  assert.ok(!cards.includes("メゾネット 不明"), "「不明」バッジは廃止した");
});

// 2026-10-05: 「メゾネットは許容する」に決まったので、賃貸の既定（チェックボックス未操作）ではメゾネットの行も
// mais パラメータを付けずにそのまま残る（バッジで示すだけ・除外しない）
test("画面（賃貸・既定）: メゾネットのチェックを入れなければ mais パラメータを付けず、メゾネットの部屋も残る", async () => {
  const h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, maisonette: true }] }));
  h.run();
  await flush();
  assert.ok(!h.requestedUrls[0]!.includes("mais="), "メゾネット除外のチェックを入れていなければ mais は付けない（既定で除外しない）");
  const cards = h.ids.get("cards")!.innerHTML;
  assert.ok(cards.includes('<span class="badge warnbadge">メゾネット</span>'), "既定でもメゾネットの部屋はバッジ付きで残る");
});

// 2026-10-20: 賃貸は注意事項を <details> で折りたたむ（既定は閉じる）。売買は今までどおり常に開く
test("画面（賃貸）: 注意事項は <details> で折りたたまれ、件数が summary に出る", async () => {
  const h = harness("", () => PAYLOAD("rent"));
  h.run();
  await flush();
  const notices = h.ids.get("notices")!.innerHTML;
  assert.match(notices, /<details class="notices-details"><summary>注意事項（1件）<\/summary>/, "summary に件数が出る");
  assert.ok(notices.includes('<div class="notice">テストの注記</div>'), "本文はこれまでどおり notice として入る");
  assert.ok(!/<details[^>]*\bopen\b/.test(notices), "既定は閉じた状態（open 属性を付けない）");
});

test("画面（売買）: 注意事項（d.notes）は表示しない", async () => {
  const h = harness("?kind=sale", () => PAYLOAD("sale"));
  h.run();
  await flush();
  const notices = h.ids.get("notices")!.innerHTML;
  assert.equal(notices, "", "売買では d.notes を出さない");
  assert.ok(!notices.includes("テストの注記"), "注記の本文が出ない");
});

// 読み込み失敗時のエラー notice は賃貸でも折りたたまない（引き続き即見える状態にする）
test("画面（賃貸）: 読み込み失敗時のエラー notice は折りたたまない", async () => {
  const ids = new Map<string, El>();
  const form = new El("form", "filters") as El & Record<string, El>;
  for (const name of ["pmax", "amin", "plan", "age", "walk", "tatami", "floors", "sort", "dk", "bus", "pets", "mais", "fresh"]) {
    (form as unknown as Record<string, El>)[name] = new El("input", name);
  }
  for (const id of [
    "tab-sale", "tab-rent", "title", "defaults-text", "lb-pmax", "lb-sort", "opt-retention", "lb-pets",
    "lb-mais", "lb-tatami", "lb-floors",
    "muni-select", "asof", "notices", "coverage", "count", "cards", "cards-section", "footer",
  ]) {
    ids.set(id, new El("div", id));
  }
  ids.set("filters", form);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    title: "",
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (tag: string) => new El(tag),
  };
  g.location = { search: "" };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  g.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });

  const html = renderListingsPicksDashboard();
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script && script[1], "埋め込みスクリプトが見つからない");
  new Function(script[1]!)();
  await flush();
  const notices = ids.get("notices")!.innerHTML;
  assert.ok(notices.includes("読み込み失敗"), "エラー文言が出る");
  assert.ok(!notices.includes("<details"), "エラーは <details> で包まない");
});

test("画面: エリアボタン3つが出て、押すと即 area= 付きで再取得・賃貸/売買で共通の保存状態に載る", async () => {
  const html = renderListingsPicksDashboard();
  assert.ok(html.indexOf("見ているエリア") > html.indexOf('id="defaults-text"') && html.indexOf("見ているエリア") < html.indexOf('id="lb-pmax"'));
  for (const l of ["空港線・筑肥線", "井尻・笹原", "南福岡・雑餉隈"]) assert.ok(html.includes(">" + l + "</button>"), l);

  const h = harness("", () => PAYLOAD("rent"));
  h.run();
  await flush();
  assert.equal(h.requestedUrls.length, 1);
  assert.ok(!h.requestedUrls[0]!.includes("area="), "全部オフなら area を付けない");
  const a = h.ids.get("area-btn-airport")!;
  const b = h.ids.get("area-btn-ijiri")!;
  a.handlers.click!();
  b.handlers.click!();
  await flush();
  assert.equal(a.className, "areabtn on");
  assert.equal(a.attrs["aria-pressed"], "true");
  assert.ok(h.requestedUrls.at(-1)!.includes("area=airport%2Cijiri"));
  b.handlers.click!();
  assert.ok(h.requestedUrls.at(-1)!.includes("area=airport") && !h.requestedUrls.at(-1)!.includes("ijiri"));
  const store = (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage;
  assert.equal(store.getItem("fcw_picks_area_v1"), '["airport"]', "タブ共通の保存キー");
});

test("画面: ?area= の初期値でボタンがオンになり、未知キーは無視", async () => {
  const h = harness("?kind=sale&area=minamifukuoka,zzz", () => PAYLOAD("sale"));
  h.run();
  await flush();
  assert.equal(h.ids.get("area-btn-minamifukuoka")!.className, "areabtn on");
  assert.equal(h.ids.get("area-btn-airport")!.className, "areabtn");
  assert.ok(h.requestedUrls[0]!.includes("area=minamifukuoka"));
});

// ---------------------------------------------------------------------------
// 見ているエリアの 4 つ目「バスで職場・学校へ直通」とカードの直通バス停（2026-10-31）
// ---------------------------------------------------------------------------

test("画面: バス直通のボタンが 4 つ目に出て、title に「直通バス停（約N か所）まで徒歩5分以内（直線320m）」", () => {
  const html = renderListingsPicksDashboard();
  const m = /<button type="button" class="areabtn" id="area-btn-bus" aria-pressed="false" title="([^"]*)">バスで職場・学校へ直通<\/button>/.exec(html);
  assert.ok(m, "バス直通のボタン");
  assert.match(m![1]!, /^直通バス停（約\d+0 か所）まで徒歩5分以内（直線320m）$/);
  assert.ok(html.indexOf('id="area-btn-minamifukuoka"') < html.indexOf('id="area-btn-bus"'), "既存の 3 つの後ろ");
  assert.match(html, /<div class="sub full hidden" id="bus-note">バスで職場・学校へ直通: 直通バス停（約\d+0 か所）まで徒歩5分以内（直線320m）/, "ボタンの下の説明（既定は隠す）");
  // 職場 = 青・学校 = オレンジ（ライト・ダーク両方に定義）
  assert.match(html, /--gion:#2563eb; --higashi:#ea580c;/);
  assert.match(html, /--gion:#3b82f6; --higashi:#f97316;/);
  assert.match(html, /\.bustag\.gion \{[^}]*var\(--gion\)/);
  assert.match(html, /\.bustag\.higashi \{[^}]*var\(--higashi\)/);
});

test("画面: バス直通を押すと area=bus で再取得・説明が出る・保存状態に載る（他のエリアと同じ扱い）", async () => {
  const h = harness("", () => PAYLOAD("rent"));
  h.run();
  await flush();
  assert.equal(h.ids.get("bus-note")!.className, "sub full hidden");
  const b = h.ids.get("area-btn-bus")!;
  b.handlers.click!();
  await flush();
  assert.equal(b.className, "areabtn on");
  assert.equal(b.attrs["aria-pressed"], "true");
  assert.ok(h.requestedUrls.at(-1)!.includes("area=bus"));
  assert.equal(h.ids.get("bus-note")!.className, "sub full", "オンのときはボタンの下に説明を出す");
  h.ids.get("area-btn-airport")!.handlers.click!();
  assert.ok(h.requestedUrls.at(-1)!.includes("area=airport%2Cbus"), "和集合で両方送る");
  const store = (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage;
  assert.equal(store.getItem("fcw_picks_area_v1"), '["airport","bus"]');
});

test("画面: ?area=bus の初期値でボタンがオン", async () => {
  const h = harness("?kind=sale&area=bus", () => PAYLOAD("sale"));
  h.run();
  await flush();
  assert.equal(h.ids.get("area-btn-bus")!.className, "areabtn on");
  assert.ok(h.requestedUrls[0]!.includes("area=bus"));
});

const BUS_ACCESS = {
  gion: { name: "南片江六丁目", meters: 170, minutes: 3, numbers: ["13"], alightAt: [] },
  higashi: { name: "呉服町", meters: 300, minutes: 5, numbers: ["32", "37", "39", "39B", "41", "73"], alightAt: ["東光二丁目", "東光町"] },
};

test("カード: 職場・学校の最寄り直通バス停をタグで出す（学校は降りるバス停を添える・番号は 4 つまで）", async () => {
  for (const kind of ["rent", "sale"]) {
    const h = harness(kind === "sale" ? "?kind=sale" : "", () => ({ ...PAYLOAD(kind), items: [{ ...CARD, busAccess: BUS_ACCESS }] }));
    h.run();
    await flush();
    const cards = h.ids.get("cards")!.innerHTML;
    assert.ok(cards.includes('<span class="bustag gion">職場へ直通: 南片江六丁目 徒歩3分（13番）</span>'), `${kind}: 職場`);
    assert.ok(
      cards.includes('<span class="bustag higashi">学校へ直通: 呉服町 徒歩5分（32・37・39・39B番ほか）（東光二丁目・東光町で降りる）</span>'),
      `${kind}: 学校`,
    );
  }
});

test("カード: 座標が国土地理院の仮座標（coordEstimated）なら直通バス停に「（住所から推定）」を添える", async () => {
  let h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, busAccess: BUS_ACCESS, coordEstimated: true }] }));
  h.run();
  await flush();
  assert.ok(h.ids.get("cards")!.innerHTML.includes('<span class="meta">（住所から推定）</span></div>'));
  h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, busAccess: BUS_ACCESS, coordEstimated: false }] }));
  h.run();
  await flush();
  assert.ok(!h.ids.get("cards")!.innerHTML.includes("住所から推定"));
  // 直通バス停が無ければ何も出さない（推定の注記だけが出ることはない）
  h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, busAccess: { gion: null, higashi: null }, coordEstimated: true }] }));
  h.run();
  await flush();
  assert.ok(!h.ids.get("cards")!.innerHTML.includes("住所から推定"));
});

test("カード: 片方だけなら片方の行だけ・両方無ければ何も出さない・座標なし（null）も何も出さない", async () => {
  const only = { gion: null, higashi: { ...BUS_ACCESS.higashi, alightAt: [] } };
  let h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, busAccess: only }] }));
  h.run();
  await flush();
  let cards = h.ids.get("cards")!.innerHTML;
  assert.ok(!cards.includes("職場へ直通"));
  assert.ok(cards.includes("学校へ直通: 呉服町 徒歩5分（32・37・39・39B番ほか）</span>"), "降りるバス停が無ければ添えない");

  for (const busAccess of [{ gion: null, higashi: null }, null, undefined]) {
    h = harness("", () => ({ ...PAYLOAD("rent"), items: [{ ...CARD, busAccess }] }));
    h.run();
    await flush();
    cards = h.ids.get("cards")!.innerHTML;
    assert.ok(!cards.includes("busline") && !cards.includes("直通"), `busAccess=${JSON.stringify(busAccess)}`);
  }
});

test("件数: バス直通オンで座標未取得を除いたときは「位置未取得のため除外 N件」を出す（0・null なら出さない）", async () => {
  let h = harness("?area=bus", () => ({ ...PAYLOAD("rent"), busExcludedNoCoord: 12 }));
  h.run();
  await flush();
  assert.ok(h.ids.get("count")!.textContent.includes("位置未取得のため除外 12件"));
  for (const v of [0, null]) {
    h = harness("", () => ({ ...PAYLOAD("rent"), busExcludedNoCoord: v }));
    h.run();
    await flush();
    assert.ok(!h.ids.get("count")!.textContent.includes("位置未取得"));
  }
});

// 2026-11-04: 数値欄の空欄は「絞らない」。初回は既定値を欄に入れて始める
function query(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}
function fields(h: Harness): Record<string, string> {
  const f = h.ids.get("filters") as unknown as Record<string, El>;
  return Object.fromEntries(["pmax", "amin", "plan", "age", "walk", "tatami", "floors"].map((k) => [k, f[k]!.value]));
}

test("画面（賃貸・初回）: 欄に既定値が入った状態で始まり、その値が送られる（徒歩・階数は空欄）。placeholder は指定なし", async () => {
  const h = harness("", () => PAYLOAD("rent"));
  h.run();
  await flush();
  assert.deepEqual(fields(h), { pmax: "15", amin: "70", plan: "3", age: "25", walk: "", tatami: "15", floors: "" });
  const q = query(h.requestedUrls[0]!);
  assert.deepEqual(
    ["pmax", "amin", "plan", "age", "walk", "tatami", "floors"].map((k) => q.get(k)),
    ["15", "70", "3", "25", "", "15", ""],
  );
  assert.ok(h.requestedUrls[0]!.includes("walk=&"), "空欄でもパラメータ自体は送る");
  const f = h.ids.get("filters") as unknown as Record<string, El>;
  assert.equal(f.pmax!.placeholder, "指定なし");
  assert.ok(h.ids.get("defaults-text")!.textContent.endsWith("空欄の項目では絞りません。"));
});

test("画面（売買・初回）: 既定値（徒歩 10）が入り、tatami・floors は送らない", async () => {
  const h = harness("?kind=sale", () => PAYLOAD("sale"));
  h.run();
  await flush();
  const f = fields(h);
  assert.deepEqual([f.pmax, f.amin, f.plan, f.age, f.walk, f.tatami, f.floors], ["4800", "70", "3", "25", "10", "", ""]);
  const q = query(h.requestedUrls[0]!);
  assert.equal(q.get("walk"), "10");
  assert.ok(!q.has("tatami") && !q.has("floors"));
});

test("画面: v2 の保存状態の空文字はそのまま復元され、空のまま送られる（既定値で埋めない）", async () => {
  const saved = { pmax: "", amin: "80", plan: "", age: "", walk: "", tatami: "", floors: "", pets: true };
  const h = harness("", () => PAYLOAD("rent"), { fcw_picks_filters_v2_rent: JSON.stringify(saved) });
  h.run();
  await flush();
  assert.deepEqual(fields(h), { pmax: "", amin: "80", plan: "", age: "", walk: "", tatami: "", floors: "" });
  const q = query(h.requestedUrls[0]!);
  assert.equal(q.get("pmax"), "");
  assert.equal(q.get("amin"), "80");
  assert.equal(q.get("tatami"), "");
});

test("画面: v1 の保存状態は移行する（数値 7 項目の空欄は既定値で埋め、チェックは引き継ぐ）。v2 があれば v1 は読まない", async () => {
  const v1 = { pmax: "", amin: "90", plan: "", age: "", walk: "7", tatami: "", floors: "", dk: true, pets: false };
  const h = harness("", () => PAYLOAD("rent"), { fcw_picks_filters_v1_rent: JSON.stringify(v1) });
  h.run();
  await flush();
  assert.deepEqual(fields(h), { pmax: "15", amin: "90", plan: "3", age: "25", walk: "7", tatami: "15", floors: "" });
  const f = h.ids.get("filters") as unknown as Record<string, El>;
  assert.equal(f.dk!.checked, true);
  assert.equal(f.pets!.checked, false);
  const ls = (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage;
  assert.ok(ls.getItem("fcw_picks_filters_v2_rent"), "保存は v2 へ");

  const both = harness("", () => PAYLOAD("rent"), {
    fcw_picks_filters_v1_rent: JSON.stringify(v1),
    fcw_picks_filters_v2_rent: JSON.stringify({ pmax: "", amin: "", plan: "", age: "", walk: "", tatami: "", floors: "" }),
  });
  both.run();
  await flush();
  assert.equal(fields(both).pmax, "");
});

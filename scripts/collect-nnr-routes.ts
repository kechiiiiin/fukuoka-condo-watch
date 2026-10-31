// 西鉄の時刻表サイトから「職場（祇園町）・学校（東光二丁目）へ乗り換えなしで着く便」が通るバス停を集める。
//   node --import tsx scripts/collect-nnr-routes.ts [--p11 <P11-22_40.geojson>] [--out src/data/bus-routes.json] [--cache-only] [--only higashi]
//   --fix-platforms: 行先名が停留所名と合わず取れなかった行先（博多駅など）を乗り場名で補う（既存の出力に追記）
//   --only <dest>: その目的地だけ集め直し、他の目的地の routes は既存の出力からそのまま引き継ぐ（追加収集用）
//   上限は環境変数で（どちらも _requests.log の累計件数）: NNR_LIMIT（既定 700）・NNR_COORD_BUDGET（座標検索を打ち切る件数・既定 660）
// 取得の作法（直列・3 秒間隔・キャッシュ・上限 700 件・連続失敗で停止）は scripts/nnr-fetch.ts。
// 再実行するとキャッシュから読むので、サイトへは新しい URL の分しか行かない。
//
// 手順
//  1. 目的バス停の行先一覧（busikisaki）から行先名を集める（その停留所を出発する便の行先）
//  2. 行先ごとに 行先 → 目的バス停 で経路検索（乗換なし・2026/11/02 月 6 時と 7 時）。直通が無ければ 目的 → 行先 で試す
//  3. 出てきた系統（keito_cd）ごとに通過時刻表（busbin）を 1 本だけ取り、停留所列を得る
//  4. 目的バス停より手前（to_dest）/ 先（from_dest）の停留所を「直通で行けるバス停」とする
//  5. 座標は停留所名検索の zahyo。上限が近ければ国土数値情報 P11 の座標で代用する
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CACHE_DIR, decodeEntities, LimitReached, nnrFetch, stats, stripTags, TooManyFailures } from "./nnr-fetch";
import { option } from "./lib";

const OUT = option("out") ?? "src/data/bus-routes.json";
const P11_PATH = option("p11") ?? "/tmp/claude-501/bus/p11/P11-22_40_SHP/P11-22_40.geojson";
const CACHE_ONLY = process.argv.includes("--cache-only");
/** 停留所の座標検索に使ってよいのは累計この件数まで（残りは再実行・調査用の余白） */
const COORD_SEARCH_BUDGET = Number(process.env.NNR_COORD_BUDGET ?? 660);
const SDATE = "2026/11/02"; // 月曜（平日ダイヤ）

type DestKey = "gion" | "higashi";
type DestStop = { name: string; listCode: string; routeId: string; lat: number; lng: number };
/** 目的地ごとの降りるバス停。higashi（東福岡）は最寄りの東光二丁目に加えて、学校から約 350〜480m の 4 か所（2026-10-31 追加） */
const DEST_STOPS: Record<DestKey, DestStop[]> = {
  gion: [{ name: "祇園町", listCode: "0001,510030", routeId: "0001,510030", lat: 33.5940762, lng: 130.4144121 }],
  higashi: [
    { name: "東光二丁目", listCode: "0001,591880", routeId: "0000,D11107", lat: 33.5967047, lng: 130.428745 },
    { name: "東光小学校前", listCode: "0001,591870", routeId: "0001,591870", lat: 33.5919763, lng: 130.432292 },
    { name: "東比恵二丁目", listCode: "0001,580070", routeId: "0001,580070", lat: 33.5911673, lng: 130.4281343 },
    { name: "東光町", listCode: "0001,580050", routeId: "0001,580050", lat: 33.5946279, lng: 130.4257954 },
    { name: "豊一丁目", listCode: "0001,591860", routeId: "0001,591860", lat: 33.5986796, lng: 130.4311247 },
  ],
};
const DESTS: Record<DestKey, DestStop> = { gion: DEST_STOPS.gion[0]!, higashi: DEST_STOPS.higashi[0]! };
const ONLY = option("only") as DestKey | undefined;

const startedAt = Date.now();
const failures: { dest: DestKey; destStop: string; terminus: string; reason: string }[] = [];
let stoppedReason: string | null = null;

function get(path: string): string | null {
  return nnrFetch(path, { cacheOnly: CACHE_ONLY });
}

// ---------- 名前の扱い ----------
const nfkc = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
/** 「呉服町（博多駅方面）I」→ 候補 [呉服町（博多駅方面）I, 呉服町（博多駅方面）, 呉服町] */
function nameCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    s = s.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(raw);
  const noLetter = raw.normalize("NFKC").replace(/\s*[A-Z](?:[・･][A-Z])*$/, "");
  push(noLetter);
  push(noLetter.replace(/[（(][^（）()]*[）)]/g, ""));
  return out;
}
/** 検算・重複除去に使う素の停留所名（乗り場の記号と（…）を落とす） */
function baseName(raw: string): string {
  const c = nameCandidates(raw);
  return c[c.length - 1]!;
}

// ---------- 停留所名検索 ----------
type SearchItem = { id: string; name: string; city: string; type: string; lat: number; lng: number };
function searchStops(keyword: string): { items: SearchItem[]; pages: number } | null {
  const body = `f=search_bustei&ftKbn=t&tkeyword=${encodeURIComponent(keyword)}`;
  const t = nnrFetch("", { method: "POST", body, cacheOnly: CACHE_ONLY });
  if (t === null) return null;
  try {
    const j = JSON.parse(t) as { List?: { id: string; name: string; city: string; type: string; zahyo: string }[]; AllPageCount?: string };
    const items = (j.List ?? []).map((x) => {
      const [lat, lng] = x.zahyo.split(",").map(Number);
      return { id: x.id, name: x.name, city: x.city, type: x.type, lat: lat!, lng: lng! };
    });
    for (const it of items) remember(it);
    return { items, pages: Number(j.AllPageCount ?? 1) };
  } catch {
    return null;
  }
}
/** 検索で一度でも見えた停留所（名前 NFKC → 候補）。バス停（type 0）と乗り場まとめ（type 2）だけ */
const known = new Map<string, SearchItem[]>();
function remember(it: SearchItem) {
  if (it.type !== "0" && it.type !== "2") return;
  // 元の名前に加えて、乗り場記号を落とした名前（博多駅前Ａ → 博多駅前、六本松（福銀前）A・B・C → 六本松（福銀前））でも引けるようにする
  for (const k of new Set([nfkc(it.name), nfkc(nameCandidates(it.name)[1] ?? it.name)])) {
    const arr = known.get(k) ?? [];
    if (!arr.some((a) => a.id === it.id)) arr.push(it);
    known.set(k, arr);
  }
}

function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** 名前（候補つき）から検索結果の停留所を選ぶ。near があれば最も近いもの */
function pickKnown(raw: string, near: { lat: number; lng: number }): SearchItem | null {
  for (const c of nameCandidates(raw)) {
    const arr = (known.get(nfkc(c)) ?? []).filter((x) => distM(x, near) < 60000);
    if (arr.length) return arr.slice().sort((a, b) => distM(a, near) - distM(b, near))[0]!;
  }
  return null;
}

/** 必要なら検索して停留所を決める。budget を超えるなら検索しない */
function resolveStop(raw: string, near: { lat: number; lng: number }, budget: number): SearchItem | null {
  let hit = pickKnown(raw, near);
  if (hit) return hit;
  const cands = nameCandidates(raw);
  // 部分一致検索なので、まず素の名前で引く（変種がまとめて返る）。見つからなければ元の名前で
  for (const kw of [cands[cands.length - 1]!, raw]) {
    if (stats().totalEver >= budget && !CACHE_ONLY) {
      const cached = nnrFetch("", { method: "POST", body: `f=search_bustei&ftKbn=t&tkeyword=${encodeURIComponent(kw)}`, cacheOnly: true });
      if (cached === null) continue;
    }
    const r = searchStops(kw);
    if (r === null) continue;
    hit = pickKnown(raw, near);
    if (hit) return hit;
  }
  return null;
}

// ---------- 行先一覧 ----------
type IkisakiRow = { kind: string; number: string; terminus: string; via: string };
function parseIkisaki(html: string): IkisakiRow[] {
  const rows: IkisakiRow[] = [];
  for (const m of html.matchAll(/<tr class=[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = m[1]!;
    const lab = r.match(/<li class="[^"]*">([^<]*)<\/li>\s*<li class="num">([^<]*)<\/li>/);
    const ps = [...r.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => stripTags(x[1]!));
    if (!lab || ps.length < 2) continue;
    rows.push({ kind: stripTags(lab[1]!), number: stripTags(lab[2]!), terminus: ps[0]!, via: ps[1]! });
  }
  return rows;
}

/** 行先名の検索候補（「藤崎・四箇田団地」は両方、「西鉄香椎(駅構内)」は括弧を落としたものも） */
function terminusCandidates(t: string): string[] {
  const out = [t];
  const noParen = t.replace(/[（(][^（）()]*[）)]/g, "").trim();
  if (noParen !== t) out.push(noParen);
  if (t.includes("・") && !known.has(nfkc(t))) for (const p of noParen.split("・")) out.push(p.trim());
  for (const o of [...out]) if (o.includes("埠頭")) out.push(o.replace(/埠頭/g, "ふ頭"));
  return [...new Set(out)];
}

// ---------- 経路検索 ----------
type Cassette = { kind: string; number: string; terminus: string; via: string; time: string; busbin: string; keitoCd: string };
function parseRoute(src: string): { direct: boolean; cassettes: Cassette[] } {
  const html = decodeEntities(src);
  if (html.includes("直通ルートは検索できませんでした")) return { direct: false, cassettes: [] };
  const out: Cassette[] = [];
  const parts = html.split('<div class="cassette">').slice(1);
  for (const p of parts) {
    const links = [...p.matchAll(/href="(busroute\?f=busbin[^"]*)"/g)].map((x) => decodeEntities(x[1]!));
    if (links.length !== 1) continue; // 乗り継ぎを含むものは除く（乗換なし検索なので通常は 1）
    const lab = p.match(/<ul class="label">\s*<li class="[^"]*">([^<]*)<\/li>\s*<li class="num">([^<]*)<\/li>/);
    const h3 = p.match(/<h3 class="station">([\s\S]*?)<span>([\s\S]*?)<\/span><\/h3>/);
    const time = p.match(/<p class="time"><span>(\d\d:\d\d)<\/span>発/);
    const keito = links[0]!.match(/keito_cd=(\d+)/);
    if (!lab || !keito) continue;
    out.push({
      kind: stripTags(lab[1]!),
      number: stripTags(lab[2]!),
      terminus: h3 ? stripTags(h3[1]!) : "",
      via: h3 ? stripTags(h3[2]!) : "",
      time: time ? time[1]! : "",
      busbin: links[0]!,
      keitoCd: keito[1]!,
    });
  }
  return { direct: out.length > 0, cassettes: out };
}
function routeUrl(fromId: string, toId: string, hour: string) {
  const e = (s: string) => s.replace(/,/g, "%2C");
  return `route?f_zahyo_flg=0&f_list=${e(fromId)}&t_zahyo_flg=0&t_list=${e(toId)}&sdate=${SDATE}&stime_h=${hour}&stime_m=00&stime_flg=1&syosaiFlg=0`;
}

// ---------- 通過時刻表 ----------
type RawStop = { raw: string; platform: string };
const clean = (s: string) => s.replace(/[\s!！※]+$/, "").trim();
/** 「名島ランプ通過」のような通過点（停車しない）は乗れる停留所に数えない */
const isPassThrough = (raw: string) => /通過$/.test(raw);
function parseBusbin(html: string): RawStop[] {
  const out: RawStop[] = [];
  for (const m of html.matchAll(/<p class="station">([\s\S]*?)<\/p>/g)) {
    const text = stripTags(m[1]!);
    const mm = text.match(/^(.*?) \((.*)\)\s*[!！※]*\s*$/);
    if (mm) out.push({ raw: clean(mm[1]!), platform: mm[2]!.trim() });
    else out.push({ raw: clean(text), platform: "" });
  }
  return out;
}

// ---------- P11 ----------
let p11: Map<string, { lat: number; lng: number }[]> | null = null;
function p11Lookup(raw: string, near: { lat: number; lng: number }) {
  if (!p11) {
    p11 = new Map();
    if (existsSync(P11_PATH)) {
      const g = JSON.parse(readFileSync(P11_PATH, "utf8")) as { features: { properties: { P11_001: string }; geometry: { coordinates: [number, number] } }[] };
      for (const f of g.features) {
        const k = nfkc(f.properties.P11_001);
        const arr = p11.get(k) ?? [];
        arr.push({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
        p11.set(k, arr);
      }
    }
  }
  for (const c of nameCandidates(raw)) {
    const arr = (p11.get(nfkc(c)) ?? []).filter((x) => distM(x, near) < 60000);
    if (arr.length) return arr.slice().sort((a, b) => distM(a, near) - distM(b, near))[0]!;
  }
  return null;
}

// ---------- 本体 ----------
type RouteOut = {
  dest: DestKey;
  destStop?: string;
  keitoCd: string;
  number: string;
  kind: string;
  terminus: string;
  via: string;
  direction: "to_dest" | "from_dest";
  queriedTerminus: string;
  morning?: { departures7to9: number; capped: boolean; from: string };
  stops: { name: string; rawName: string; platform: string; passThrough?: true; lat: number | null; lng: number | null; coordSource: "nnr-search" | "p11" | null; city?: string }[];
  destIndex: number;
  platformFix?: true;
};

type Job = { dest: DestKey; ds: DestStop; terminus: string; direction: "to_dest" | "from_dest"; cassette: Cassette };

/** 系統（keito_cd）→ 停留所列。通過時刻表は始発からの全停留所を出すので、乗る区間が違っても系統が同じなら同じ列。
 *  キャッシュ済みの通過時刻表から先に作っておき、取得済みの系統は取り直さない */
function cachedKeitoStops(): Map<string, string> {
  const m = new Map<string, string>();
  const ledger = `${CACHE_DIR}/_requests.log`;
  if (!existsSync(ledger)) return m;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    const url = line.split("\t")[2];
    const k = url?.match(/f=busbin.*keito_cd=(\d+)/);
    if (!url || !k || m.has(k[1]!)) continue;
    const t = nnrFetch(url, { cacheOnly: true });
    if (t) m.set(k[1]!, t);
  }
  return m;
}

let keitoCache: Map<string, string> | undefined;

/** 便（job）ごとに停留所列を作る。取得済みの系統は通過時刻表を取り直さない */
function buildRoutes(jobs: Map<string, Job>, morning: Map<string, { n: number; total: number; from: string }>, extra: Partial<RouteOut> = {}): { routes: RouteOut[]; keitoReused: number } {
  const routes: RouteOut[] = [];
  const keitoHtml = keitoCache ??= cachedKeitoStops();
  let keitoReused = 0;
  try {
    for (const [key, job] of jobs) {
      let h = keitoHtml.get(job.cassette.keitoCd) ?? null;
      if (h) keitoReused++;
      else {
        h = get(job.cassette.busbin);
        if (h) keitoHtml.set(job.cassette.keitoCd, h);
      }
      if (!h) {
        failures.push({ dest: job.dest, destStop: job.ds.name, terminus: job.terminus, reason: `通過時刻表が取れない（keito ${job.cassette.keitoCd}）` });
        continue;
      }
      const raw = parseBusbin(h);
      const dName = job.ds.name;
      const destIndex = raw.findIndex((s) => baseName(s.raw) === dName);
      if (destIndex < 0) {
        failures.push({ dest: job.dest, destStop: dName, terminus: job.terminus, reason: `通過時刻表に ${dName} が無い（keito ${job.cassette.keitoCd}）` });
        continue;
      }
      const m = morning.get(key);
      routes.push({
        dest: job.dest,
        ...(job.dest === "higashi" ? { destStop: dName } : {}),
        keitoCd: job.cassette.keitoCd,
        number: job.cassette.number,
        kind: job.cassette.kind,
        terminus: job.cassette.terminus,
        via: job.cassette.via,
        direction: job.direction,
        queriedTerminus: job.terminus,
        ...(m ? { morning: { departures7to9: m.n, capped: m.n === m.total && m.total > 0, from: m.from } } : {}),
        stops: raw.map((s) => ({
          name: baseName(s.raw),
          rawName: s.raw,
          platform: s.platform,
          ...(isPassThrough(s.raw) ? { passThrough: true as const } : {}),
          lat: null,
          lng: null,
          coordSource: null,
        })),
        destIndex,
        ...extra,
      });
    }
  } catch (e) {
    if (e instanceof LimitReached || e instanceof TooManyFailures) stoppedReason = (e as Error).message;
    else throw e;
  }
  return { routes, keitoReused };
}

/** 座標: 直通で行ける側の停留所と目的バス停。近い順に決めていく（前後の停留所に最も近い同名を選ぶ）。P11 で代用した数を返す */
function assignCoords(routes: RouteOut[]): number {
  let p11Used = 0;
  try {
    for (const r of routes) {
      const d = DEST_STOPS[r.dest].find((x) => x.name === (r.destStop ?? DESTS[r.dest].name))!;
      const idxs = r.stops.map((_, i) => i);
      // 目的バス停から外へ向かって決めると「前後の停留所」の座標が先に決まっている
      const order = r.direction === "to_dest" ? idxs.slice(0, r.destIndex + 1).reverse() : idxs.slice(r.destIndex);
      let prev: { lat: number; lng: number } = d;
      for (const i of order) {
        const s = r.stops[i]!;
        if (s.passThrough) continue;
        if (i === r.destIndex) {
          Object.assign(s, { lat: d.lat, lng: d.lng, coordSource: "nnr-search" as const });
          prev = d;
          continue;
        }
        const hit = resolveStop(s.rawName, prev, COORD_SEARCH_BUDGET);
        if (hit && distM(hit, prev) < 15000) {
          Object.assign(s, { lat: hit.lat, lng: hit.lng, coordSource: "nnr-search" as const, city: hit.city });
          prev = hit;
          continue;
        }
        const p = p11Lookup(s.rawName, prev);
        if (p && distM(p, prev) < 15000) {
          Object.assign(s, { lat: p.lat, lng: p.lng, coordSource: "p11" as const });
          p11Used++;
          prev = p;
        }
      }
    }
  } catch (e) {
    if (e instanceof LimitReached || e instanceof TooManyFailures) stoppedReason = (e as Error).message;
    else throw e;
  }
  return p11Used;
}

type StopOut = { name: string; lat: number | null; lng: number | null; city?: string; coordSource: string | null; dests: DestKey[]; numbers: string[]; higashiStops?: string[] };
/** 直通で行けるバス停（重複除去: 同名で 500m 以内は同じ停留所） */
function buildStops(allRoutes: RouteOut[]): StopOut[] {
  const stops: StopOut[] = [];
  // 目的 → 行先 の向きでしか直通が出なかった便（from_dest）は stops[] に入れない。
  // 帰りの便が目的バス停を通る保証が無く、実際 福大病院 → 祇園町 は公式検索で直通なし（行きの 12 番は祇園町を通るが帰りは通らない）
  for (const r of allRoutes) {
    if (r.direction !== "to_dest") continue;
    const reach = r.stops.slice(0, r.destIndex).filter((s) => !s.passThrough);
    for (const s of reach) {
      let o = stops.find(
        (x) => x.name === s.name && (x.lat === null || s.lat === null ? x.lat === s.lat : distM({ lat: x.lat, lng: x.lng! }, { lat: s.lat, lng: s.lng! }) < 500),
      );
      if (!o) {
        o = { name: s.name, lat: s.lat, lng: s.lng, ...(s.city ? { city: s.city } : {}), coordSource: s.coordSource, dests: [], numbers: [] };
        stops.push(o);
      }
      if (!o.dests.includes(r.dest)) o.dests.push(r.dest);
      if (!o.numbers.includes(r.number)) o.numbers.push(r.number);
      if (r.dest === "higashi") {
        const ds = r.destStop ?? DESTS.higashi.name;
        o.higashiStops ??= [];
        if (!o.higashiStops.includes(ds)) o.higashiStops.push(ds);
      }
    }
  }
  return stops;
}

// ---------- 行先名が停留所名と合わなかった行先の補い（--fix-platforms） ----------
// 行先一覧の行先名（例「博多駅」）がそのままの停留所名で無いため取れなかった行先を、実際の乗り場名で引き直す。
// 1 つの行先につき経路検索は最大 4 回（行先 → 目的の向き・6 時）。出た乗り場はすべて使う（乗り場ごとに出る系統が違う）
/** 行先名 → 停留所名検索のキーワードと、試す乗り場名（目的地ごとに優先順） */
const PLATFORM_ALIASES: Record<string, { keywords: string[]; gion: string[]; higashi: string[] }> = {
  // 祇園町発「博多駅」行きは博多バスターミナル着（「博多駅前」行きは博多口前で別行先）。帰りは博多駅の博多口側・筑紫口側の乗り場から
  博多駅: {
    keywords: ["博多駅", "博多バスターミナル"],
    gion: ["博多バスターミナル１Ｆ", "博多駅前Ａ", "博多駅センタービル前Ｅ", "博多駅西日本シティ銀行前Ｆ"],
    higashi: ["博多バスターミナル１Ｆ", "博多駅筑紫口", "博多駅センタービル前Ｅ", "博多駅博多郵便局前D"],
  },
  大橋駅: { keywords: ["大橋駅"], gion: ["西鉄大橋駅"], higashi: ["西鉄大橋駅"] },
  中央埠頭: { keywords: ["中央ふ頭"], gion: ["博多港国際ターミナル（中央ふ頭）", "中央ふ頭クルーズセンター"], higashi: ["博多港国際ターミナル（中央ふ頭）", "中央ふ頭クルーズセンター"] },
  井尻六ッ角: { keywords: ["井尻六"], gion: ["井尻六ツ角", "井尻六ツ角（高宮通り）"], higashi: ["井尻六ツ角", "井尻六ツ角（高宮通り）"] },
};

type Failure = { dest: DestKey; destStop?: string; terminus: string; reason: string };
function fixPlatforms() {
  const prev = JSON.parse(readFileSync(OUT, "utf8")) as { meta: Record<string, any>; routes: RouteOut[]; stops: StopOut[] };
  const nameMismatch = (f: Failure) => f.reason.startsWith("停留所名検索で一致する停留所なし");
  const lists: Failure[][] = [prev.meta.failures, prev.meta.higashiExtension?.failures ?? []];
  const targets = lists.flatMap((l) => l.filter(nameMismatch));
  const found: { dest: DestKey; destStop: string; terminus: string; platform: string; keitoCd: string; numbers: string[]; newStops: number }[] = [];
  const tried: Record<string, { platform: string; result: string }[]> = {};
  const jobs = new Map<string, Job>();
  const jobPlatform = new Map<string, { term: string; platform: string }>();
  const directFound = new Set<string>(); // 乗り場名で直通が出た行先（系統が既存と同じだけでも、行先としては拾えている）
  try {
    for (const f of targets) {
      const ds = DEST_STOPS[f.dest].find((x) => x.name === (f.destStop ?? DESTS[f.dest].name))!;
      const alias = PLATFORM_ALIASES[f.terminus];
      const key = `${f.dest}|${ds.name}|${f.terminus}`;
      tried[key] = [];
      if (!alias) continue;
      for (const kw of alias.keywords) searchStops(kw);
      for (const platform of alias[f.dest].slice(0, 4)) {
        const st = (known.get(nfkc(platform)) ?? []).sort((a, b) => distM(a, ds) - distM(b, ds))[0];
        if (!st) {
          tried[key].push({ platform, result: "停留所名検索に無い" });
          continue;
        }
        const h = get(routeUrl(st.id, ds.routeId, "06"));
        const r = h === null ? null : parseRoute(h);
        tried[key].push({ platform, result: r === null ? "取得失敗" : r.direct ? `直通あり（${[...new Set(r.cassettes.map((c) => c.number))].join(",")}）` : "直通なし" });
        if (!r?.direct) continue;
        directFound.add(key);
        for (const c of r.cassettes) {
          const jk = `${f.dest}|${ds.name}|to_dest|${c.keitoCd}`;
          if (prev.routes.some((x) => x.dest === f.dest && (x.destStop ?? DESTS[f.dest].name) === ds.name && x.direction === "to_dest" && x.keitoCd === c.keitoCd)) continue; // 既に持っている系統
          if (!jobs.has(jk)) {
            jobs.set(jk, { dest: f.dest, ds, terminus: `${f.terminus}（${platform}）`, direction: "to_dest", cassette: c });
            jobPlatform.set(jk, { term: f.terminus, platform });
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof LimitReached || e instanceof TooManyFailures) stoppedReason = (e as Error).message;
    else throw e;
  }
  const { routes, keitoReused } = buildRoutes(jobs, new Map(), { platformFix: true } as Partial<RouteOut>);
  const p11Used = assignCoords(routes);
  const allRoutes = [...prev.routes, ...routes];
  const stops = buildStops(allRoutes);

  // 系統ごとの「増えた直通バス停」: その目的バス停へ前回まで行けなかった停留所の数
  const reachKey = (r: RouteOut) => `${r.dest}|${r.destStop ?? DESTS[r.dest].name}`;
  const before = new Map<string, Set<string>>();
  for (const r of prev.routes) {
    if (r.direction !== "to_dest") continue;
    const set = before.get(reachKey(r)) ?? new Set<string>();
    for (const x of r.stops.slice(0, r.destIndex)) if (!x.passThrough) set.add(x.name);
    before.set(reachKey(r), set);
  }
  for (const r of routes) {
    const jp = [...jobPlatform.entries()].find(([k]) => k === `${r.dest}|${r.destStop ?? DESTS[r.dest].name}|to_dest|${r.keitoCd}`)?.[1];
    const set = before.get(reachKey(r)) ?? new Set<string>();
    const fresh = r.stops.slice(0, r.destIndex).filter((x) => !x.passThrough && !set.has(x.name)).map((x) => x.name);
    found.push({ dest: r.dest, destStop: r.destStop ?? DESTS[r.dest].name, terminus: jp?.term ?? "", platform: jp?.platform ?? "", keitoCd: r.keitoCd, numbers: [r.number], newStops: new Set(fresh).size });
  }

  // failures: 拾えた行先は外し、拾えなかった行先には試した乗り場名を残す
  const pickedUp = directFound;
  const rewrite = (l: Failure[]) =>
    l.flatMap((f) => {
      if (!nameMismatch(f)) return [f];
      const key = `${f.dest}|${f.destStop ?? DESTS[f.dest].name}|${f.terminus}`;
      if (pickedUp.has(key)) return [];
      const t = tried[key] ?? [];
      return [{ ...f, reason: `停留所名検索で一致する停留所なし。乗り場名で試したが直通なし: ${t.map((x) => `${x.platform}=${x.result}`).join("、") || "候補なし"}` }];
    });
  const st = stats();
  const meta = {
    ...prev.meta,
    requestsTotal: st.totalEver,
    failures: rewrite(prev.meta.failures),
    ...(prev.meta.higashiExtension ? { higashiExtension: { ...prev.meta.higashiExtension, failures: rewrite(prev.meta.higashiExtension.failures) } } : {}),
    missingCoordCount: stops.filter((x) => x.lat === null).length,
    platformFix: {
      note: "行先名（博多駅など）が停留所名と合わず取れなかった行先を、実際の乗り場名で 行先→目的・6時 の経路検索をし直して補った（1 行先 4 回まで。朝の本数は取っていない）",
      generatedAt: new Date().toISOString(),
      // 前回の出力以降に台帳へ増えた件数（キャッシュから再実行しても変わらない）
      requests: st.totalEver - Number(prev.meta.requestsTotal ?? 0),
      keitoReusedFromCache: keitoReused,
      stoppedReason,
      p11CoordCount: p11Used,
      tried,
      found,
      coveredByExistingKeito: [...directFound].filter((k) => !found.some((x) => `${x.dest}|${x.destStop}|${x.terminus}` === k)),
    },
  };
  writeFileSync(OUT, JSON.stringify({ meta, routes: allRoutes, stops }, null, 1) + "\n");
  console.log(`補った系統 ${routes.length}（系統の再利用 ${keitoReused}） / stops ${prev.stops.length} → ${stops.length} / requests this run ${st.network} total ${st.totalEver}`);
  if (stoppedReason) console.log(`停止: ${stoppedReason}`);
  for (const [k, t] of Object.entries(tried)) console.log(`  ${k}: ${t.map((x) => `${x.platform}=${x.result}`).join("、")}`);
}

function main() {
  const jobs = new Map<string, Job>(); // dest|destStop|direction|keitoCd → 最初に見つけた便
  const morning = new Map<string, { n: number; total: number; from: string }>(); // 同上
  const terminusIds = new Map<string, SearchItem>();
  const prev = ONLY && existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { meta: Record<string, unknown>; routes: RouteOut[] }) : null;
  const destKeys = ONLY ? [ONLY] : (Object.keys(DEST_STOPS) as DestKey[]);

  try {
    for (const dk of destKeys) for (const d of DEST_STOPS[dk]) {
      const html = get(`busroute?f=busikisaki&list=${d.listCode}&ns=1`);
      if (!html) throw new Error(`${d.name} の行先一覧が取れません`);
      const rows = parseIkisaki(html);
      const termini = [...new Set(rows.map((r) => r.terminus))];
      console.log(`${d.name}: 行先一覧 ${rows.length} 行・行先 ${termini.length} 種`);

      for (const term of termini) {
        // 行先の停留所 id
        let st: SearchItem | null = null;
        let usedName = term;
        for (const c of terminusCandidates(term)) {
          st = resolveStop(c, d, Infinity);
          if (st) {
            usedName = c;
            break;
          }
        }
        if (!st) {
          // 「野方」→「野方（営業所）」のように、括弧書きつきの停留所しか無いときはそれを使う（目的バス停に最も近いもの）
          const pre = nfkc(term) + "(";
          const cands = [...known.entries()].filter(([k]) => k.startsWith(pre)).flatMap(([, v]) => v);
          if (cands.length) {
            st = cands.sort((x, y) => distM(x, d) - distM(y, d))[0]!;
            usedName = st.name;
          }
        }
        if (!st) {
          failures.push({ dest: dk, destStop: d.name, terminus: term, reason: "停留所名検索で一致する停留所なし" });
          continue;
        }
        terminusIds.set(term, st);
        // 行先 → 目的、だめなら 目的 → 行先
        let found = false;
        for (const direction of ["to_dest", "from_dest"] as const) {
          const [f, t] = direction === "to_dest" ? [st.id, d.routeId] : [d.routeId, st.id];
          for (const hour of ["06", "07"]) {
            const h = get(routeUrl(f, t, hour));
            if (h === null) continue;
            const r = parseRoute(h);
            if (!r.direct) break; // 6 時以降に 1 本も無ければ 7 時も無い
            found = true;
            for (const c of r.cassettes) {
              const key = `${dk}|${d.name}|${direction}|${c.keitoCd}`;
              if (!jobs.has(key)) jobs.set(key, { dest: dk, ds: d, terminus: usedName, direction, cassette: c });
              if (hour === "07") {
                const m = morning.get(key) ?? { n: 0, total: 0, from: st.name };
                const hh = Number(c.time.slice(0, 2));
                if (hh >= 7 && hh <= 9) m.n++;
                m.total = r.cassettes.length;
                morning.set(key, m);
              }
            }
          }
          if (found) break;
        }
        if (!found) failures.push({ dest: dk, destStop: d.name, terminus: term, reason: `直通なし（${usedName} との両方向・6時/7時）` });
      }
    }
  } catch (e) {
    if (e instanceof LimitReached || e instanceof TooManyFailures) stoppedReason = (e as Error).message;
    else throw e;
  }

  // 通過時刻表
  // --only のときは他の目的地の routes を既存の出力からそのまま引き継ぐ（座標も決め直さない）
  const kept: RouteOut[] = prev ? prev.routes.filter((r) => r.dest !== ONLY) : [];
  const { routes, keitoReused } = buildRoutes(jobs, morning);
  const p11Used = assignCoords(routes);
  const allRoutes = [...kept, ...routes];
  const stops = buildStops(allRoutes);

  const st = stats();
  const fromDestOnly = allRoutes
    .filter((r) => r.direction === "from_dest")
    .map((r) => ({ dest: r.dest, ...(r.destStop ? { destStop: r.destStop } : {}), number: r.number, terminus: r.terminus, note: "行先→目的では直通が出ず、目的→行先でだけ出た。通勤の向きで乗れる保証が無いので stops[] には入れていない" }));
  const metaFull = {
      source: "西鉄 時刻・運賃検索 https://jik.nishitetsu.jp/（経路検索は乗換なし・2026/11/02 平日ダイヤ 6時台/7時台）",
      coordSources: { "nnr-search": "西鉄の停留所名検索の zahyo", p11: "国土数値情報 P11 バス停留所 2022 福岡県（P11_001 で名前一致・前後の停留所に最も近いもの）" },
      generatedAt: new Date().toISOString(),
      requestsThisRun: st.network,
      requestsTotal: st.totalEver,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      stoppedReason,
      dests: Object.fromEntries(Object.entries(DESTS).map(([k, v]) => [k, { name: v.name, code: v.listCode, lat: v.lat, lng: v.lng }])),
      failures,
      fromDestOnly,
      p11CoordCount: p11Used,
      missingCoordCount: stops.filter((s) => s.lat === null).length,
  };
  // --only（追加収集）のときは前回の meta を土台に、追加分を higashiExtension として追記する
  const meta = prev
    ? {
        ...prev.meta,
        requestsTotal: st.totalEver,
        destStops: Object.fromEntries(Object.entries(DEST_STOPS).map(([k, v]) => [k, v.map((x) => ({ name: x.name, code: x.listCode, lat: x.lat, lng: x.lng }))])),
        fromDestOnly,
        missingCoordCount: stops.filter((s) => s.lat === null).length,
        [`${ONLY}Extension`]: {
          note: "学校（東福岡）近くの 4 バス停（東光小学校前・東比恵二丁目・東光町・豊一丁目）を目的バス停に追加。東光二丁目分も destStop つきで作り直し",
          generatedAt: new Date().toISOString(),
          requests: st.network,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          keitoReusedFromCache: keitoReused,
          stoppedReason,
          failures: failures.filter((f) => f.destStop !== DESTS[ONLY!].name),
          p11CoordCount: p11Used,
        },
      }
    : metaFull;
  const out = { meta, routes: allRoutes, stops };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`routes ${allRoutes.length}（今回 ${routes.length}・系統の再利用 ${keitoReused}） / stops ${stops.length} / requests this run ${st.network} total ${st.totalEver} / ${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (stoppedReason) console.log(`停止: ${stoppedReason}`);
  for (const f of failures) console.log(`  取れず: [${f.dest}/${f.destStop}] ${f.terminus} — ${f.reason}`);
}

if (process.argv.includes("--fix-platforms")) fixPlatforms();
else main();

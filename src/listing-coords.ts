// 掲載の建物の座標（緯度・経度）を SUUMO のページから読む部品。Mac 側（scripts/suumo-coords.ts）とテストが使う。
// D1・Env に依存させないこと（scripts/ の tsconfig には Workers の型が無い）。
//
// 座標の在りか（2026-10-31 に本番のページで 1 件ずつ確認。保存はしていない）:
//   - 中古（/ms/chuko/fukuoka/sc_*/nc_<id>/）… 詳細ページそのものに地図の初期化がある
//       initIdo : '33.5780391497897',
//       initKeido : '130.403190180308',
//       … {lat:'33.5780391497897', lng:'130.403190180308', icon:'/jj/jjcommon/img/map/icon_map_011.png', click:''}
//   - 賃貸（/chintai/jnc_<掲載 ID>/?bc=<部屋 ID>）… **詳細ページには座標が無い**（数字の 33.xxxxx が 1 つも出ない）。
//       「周辺環境」ページ（/chintai/jnc_<掲載 ID>/kankyo/?bc=<部屋 ID>）の
//       <script id="js-gmapData" type="application/json"> { "center": { "lat": 33.57…, "lng": 130.39… }, …,
//         "markers": [ { "type": "room", "lat": …, "lng": … } ] }
//       と、同じページのフォーム action="/jj/JJ903FC012/?ido=33.57…&keido=130.39…" にある。
//     そのため賃貸の LDK 畳数の周回（scripts/suumo-chintai-detail.ts）では一緒に読めない（別のページを 1 回余分に取ることになる）。

/** 読めた座標。読めなければ null */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 日本の範囲に収まる値だけを座標として認める（桁ずれ・0 埋め・緯度経度の取り違えを捨てる）。
 * 対象は福岡県内だけだが、ここでは「明らかにおかしい値」を落とすだけにして、範囲はゆるく取る。
 */
export function plausibleLatLng(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return null;
  return { lat, lng };
}

const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s));

/** 中古の詳細ページ → 座標。initIdo / initKeido が正、無ければ地図のマーカー {lat:'…', lng:'…'} */
export function parseSaleDetailCoords(html: string): LatLng | null {
  const ido = /initIdo\s*:\s*['"]?(-?\d+(?:\.\d+)?)/.exec(html)?.[1];
  const keido = /initKeido\s*:\s*['"]?(-?\d+(?:\.\d+)?)/.exec(html)?.[1];
  const a = plausibleLatLng(num(ido), num(keido));
  if (a) return a;
  const m = /\{\s*lat\s*:\s*['"]?(-?\d+(?:\.\d+)?)['"]?\s*,\s*lng\s*:\s*['"]?(-?\d+(?:\.\d+)?)/.exec(html);
  return m ? plausibleLatLng(num(m[1]), num(m[2])) : null;
}

/**
 * 賃貸の周辺環境ページ → 座標。js-gmapData の JSON（部屋のマーカー → 地図の中心の順）、
 * 読めなければフォームの ido= / keido=。
 */
export function parseChintaiKankyoCoords(html: string): LatLng | null {
  const script = /<script[^>]*id="js-gmapData"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script) {
    try {
      const d = JSON.parse(script) as {
        center?: { lat?: unknown; lng?: unknown };
        markers?: { type?: unknown; lat?: unknown; lng?: unknown }[];
      };
      const room = Array.isArray(d.markers) ? d.markers.find((m) => m && m.type === "room") : undefined;
      for (const p of [room, d.center]) {
        if (p && typeof p.lat === "number" && typeof p.lng === "number") {
          const v = plausibleLatLng(p.lat, p.lng);
          if (v) return v;
        }
      }
    } catch {
      /* JSON が壊れていたら下の ido= / keido= に頼る */
    }
  }
  const m = /[?&;]ido=(-?\d+(?:\.\d+)?)&(?:amp;)?keido=(-?\d+(?:\.\d+)?)/.exec(html);
  return m ? plausibleLatLng(num(m[1]), num(m[2])) : null;
}

/** 中古の詳細ページらしい構造があるか（captcha・メンテ・構造変更の判定に使う） */
export function hasSaleDetailStructure(html: string): boolean {
  return /initIdo/.test(html) || /物件概要/.test(html);
}

/** 賃貸の周辺環境ページらしい構造があるか */
export function hasChintaiKankyoStructure(html: string): boolean {
  return /id="js-gmapData"/.test(html) || /周辺環境/.test(html);
}

/**
 * 賃貸の詳細ページの URL → 周辺環境ページの URL。
 * https://suumo.jp/chintai/jnc_000110720394/?bc=100533812589 → https://suumo.jp/chintai/jnc_000110720394/kankyo/?bc=100533812589
 * 形が違えば null（取りに行かない）。
 */
export function chintaiKankyoUrl(detailUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(detailUrl);
  } catch {
    return null;
  }
  const m = /^\/chintai\/(jnc_\d+)\/$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = `/chintai/${m[1]}/kankyo/`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// 国土地理院の住所検索（https://msearch.gsi.go.jp/address-search/AddressSearch?q=<住所>）。scripts/gsi-coords.ts が使う
// ---------------------------------------------------------------------------
//
// 応答は GeoJSON の Feature 風の配列（2026-11-01 に実測）:
//   [{ "geometry": { "coordinates": [130.443893, 33.623783], "type": "Point" },
//      "type": "Feature", "properties": { "addressCode": "", "title": "福岡県福岡市東区原田四丁目１６番３６号" } }, …]
// - coordinates は **[経度, 緯度]** の順
// - 住所で引く（マンション名では引けない）。番地まで一致しなければ丁目・町の代表点が返るので、
//   **先頭の結果の title に「番」が含まれるときだけ**採る（丁目止まりの代表点は直通バス停 320m の判定には粗すぎる）
// - 実測: 原田４-16-36 → 33.623783, 130.443893「…原田四丁目１６番３６号」（SUUMO の地図は 33.62416, 130.44419）・
//         香椎浜２-5-1 → 33.655037, 130.425308「…香椎浜二丁目５番」・平尾浄水町（番地なし）→「…平尾浄水町」で採らない

/** 国土地理院の住所検索 URL */
export function gsiAddressSearchUrl(address: string): string {
  return `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`;
}

/** 国土地理院の住所検索の応答（JSON を parse したもの）→ 番地まで一致した座標。採らなければ null */
export function parseGsiAddressSearch(json: unknown): LatLng | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const f = json[0] as { geometry?: { coordinates?: unknown }; properties?: { title?: unknown } } | null;
  if (!f || typeof f !== "object") return null;
  const title = f.properties?.title;
  if (typeof title !== "string" || !title.includes("番")) return null;
  const c = f.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== "number" || typeof c[1] !== "number") return null;
  return plausibleLatLng(c[1], c[0]);
}

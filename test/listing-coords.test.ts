// 掲載の座標の読み取り（src/listing-coords.ts）と、Mac → Worker の取り込み要求（coord_targets / coord_results）の検証。
// ページの骨格は 2026-10-31 に本番で 1 件ずつ取ったページ（中古の詳細・賃貸の周辺環境）の該当部分を写したもの
// （ページそのものはリポジトリに入れない）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { COORD_MAX_PER_RUN, CHINTAI_DETAIL_MAX_PER_RUN, parseIngestRequest } from "../src/listing-crawl-core.ts";
import {
  chintaiKankyoUrl,
  hasChintaiKankyoStructure,
  hasSaleDetailStructure,
  parseChintaiKankyoCoords,
  parseSaleDetailCoords,
  plausibleLatLng,
} from "../src/listing-coords.ts";

const SALE_DETAIL = `<html><head><title>【SUUMO】東峰マンション大宮 中古マンション物件情報</title></head><body>
<h2>物件概要</h2>
<script type="text/javascript">
var mapParam = {
		initIdo : '33.5780391497897',
		initKeido : '130.403190180308',
		zoom : 16
};
var markers = [{lat:'33.5780391497897', lng:'130.403190180308', icon:'/jj/jjcommon/img/map/icon_map_011.png', click:''}];
</script></body></html>`;

const RENT_KANKYO = `<html><head><title>【SUUMO】4LDK/2階/95.51m2／福岡県福岡市中央区平尾浄水町／桜坂駅の賃貸・部屋探し情報（000110720394）- 周辺環境</title></head><body>
<form method="get" action="/jj/JJ903FC012/?ido=33.573572895253&keido=130.391466146416" id="js-timesForm"></form>
<script id="js-gmapData" type="application/json">
	{
		"center": {
			"lat": 33.573572895253,
			"lng": 130.391466146416
		},
		"zoom": 16,
		"minZoom": 5,
		"channel": "suumo-chintai-shosai",
		"markers": [
			{
				"type": "room",
				"lat": 33.573572895253,
				"lng": 130.391466146416
			}
		]
	}
</script></body></html>`;

test("中古の詳細ページ: initIdo / initKeido から座標が読める（無ければ地図のマーカー）", () => {
  assert.deepEqual(parseSaleDetailCoords(SALE_DETAIL), { lat: 33.5780391497897, lng: 130.403190180308 });
  assert.ok(hasSaleDetailStructure(SALE_DETAIL));
  const markerOnly = SALE_DETAIL.replace(/initIdo[^\n]*\n/, "").replace(/initKeido[^\n]*\n/, "");
  assert.deepEqual(parseSaleDetailCoords(markerOnly), { lat: 33.5780391497897, lng: 130.403190180308 });
  assert.equal(parseSaleDetailCoords("<html>物件概要</html>"), null, "座標が無ければ null");
  assert.equal(parseSaleDetailCoords("initIdo : '0', initKeido : '0'"), null, "0 埋めは座標とみなさない");
});

test("賃貸の周辺環境ページ: js-gmapData の部屋のマーカーから読める（壊れていれば ido= / keido=）", () => {
  assert.deepEqual(parseChintaiKankyoCoords(RENT_KANKYO), { lat: 33.573572895253, lng: 130.391466146416 });
  assert.ok(hasChintaiKankyoStructure(RENT_KANKYO));
  const broken = RENT_KANKYO.replace('"zoom": 16,', '"zoom": 16,,');
  assert.deepEqual(parseChintaiKankyoCoords(broken), { lat: 33.573572895253, lng: 130.391466146416 });
  // 賃貸の詳細ページ（周辺環境ではない方）には座標が無い
  assert.equal(parseChintaiKankyoCoords("<html><table class=\"table_gaiyou\">間取り詳細</table></html>"), null);
});

test("賃貸の詳細ページ URL → 周辺環境ページ URL（形が違えば null）", () => {
  assert.equal(
    chintaiKankyoUrl("https://suumo.jp/chintai/jnc_000110720394/?bc=100533812589"),
    "https://suumo.jp/chintai/jnc_000110720394/kankyo/?bc=100533812589",
  );
  assert.equal(chintaiKankyoUrl("https://suumo.jp/chintai/bc_100533812589/"), null);
  assert.equal(chintaiKankyoUrl("not a url"), null);
});

test("座標のふるい: 日本の外・緯度経度の取り違えは捨てる", () => {
  assert.deepEqual(plausibleLatLng(33.6, 130.4), { lat: 33.6, lng: 130.4 });
  assert.equal(plausibleLatLng(130.4, 33.6), null);
  assert.equal(plausibleLatLng(Number.NaN, 130.4), null);
});

test("取り込み要求: coord_targets / coord_results の検証（上限は詳細ページの周回と同じ 60 件）", () => {
  assert.equal(COORD_MAX_PER_RUN, CHINTAI_DETAIL_MAX_PER_RUN);
  assert.deepEqual(parseIngestRequest({ op: "coord_targets", limit: 60 }), { op: "coord_targets", kind: "chuko", limit: 60 });
  assert.throws(() => parseIngestRequest({ op: "coord_targets", limit: 61 }));

  const r = parseIngestRequest({
    op: "coord_results",
    fetchedAt: "2026-10-31T11:00:00Z",
    results: [
      { externalId: "21806428", kind: "sale", lat: 33.578, lng: 130.403 },
      { externalId: "100533812589", kind: "rent", lat: null, lng: null },
      { externalId: "100533812590", kind: "rent", lat: 33.5, lng: null },
    ],
  });
  assert.equal(r.op, "coord_results");
  assert.deepEqual(r.op === "coord_results" ? r.results : null, [
    { externalId: "21806428", kind: "sale", lat: 33.578, lng: 130.403 },
    { externalId: "100533812589", kind: "rent", lat: null, lng: null },
    { externalId: "100533812590", kind: "rent", lat: null, lng: null },
  ], "片方だけの座標は両方 null にする");
  assert.throws(() => parseIngestRequest({ op: "coord_results", fetchedAt: "2026-10-31T11:00:00Z", results: [{ externalId: "1", kind: "x", lat: null, lng: null }] }));
  assert.throws(() => parseIngestRequest({ op: "coord_results", fetchedAt: "2026-10-31T11:00:00Z", results: [{ externalId: "1", kind: "sale", lat: 130.4, lng: 33.6 }] }), /lat \/ lng/);
  assert.throws(() => parseIngestRequest({ op: "coord_results", fetchedAt: "x", results: [] }));
  assert.throws(() => parseIngestRequest({ op: "coord_results", fetchedAt: "2026-10-31T11:00:00Z", results: new Array(61).fill({ externalId: "1", kind: "sale" }) }));
});

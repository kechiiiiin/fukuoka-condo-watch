# fukuoka-condo-watch

福岡市 7 区と福岡都市圏の近郊 16 市町の中古マンション市場を毎日追いかけて、「どこが売りやすいか（流動性・価格維持）」と「どこが貸しやすいか（賃貸需要）」を市区町村・地区ごとに見る Cloudflare Worker。ダッシュボードは「福岡市のみ／近郊のみ／すべて」を切り替え、ランキングは選んだ範囲の中で付ける。

- 公開ダッシュボード（`/`）のデータは公的な公開情報だけ（国土交通省 不動産情報ライブラリ API・e-Stat）
- 掲載情報（SUUMO・私的利用）の日次取得を**同梱しているが既定は無効**（`LISTINGS_ENABLED=off`）。見る画面 `/listings` は Cloudflare Access で非公開。下の「掲載情報（SUUMO）」
- Cloudflare Workers（TypeScript）+ D1 + Cron Trigger。デプロイは GitHub Actions + `cloudflare/wrangler-action`

## 仕組み

| 部品 | 役割 |
|---|---|
| `src/index.ts` | `/` ダッシュボード、`/api/metrics`（フィルタ付き集計 JSON）、`/api/status`、cron |
| `src/wards.ts` | 対象市区町村の台帳（`AREAS`。区＝`city`・近郊＝`suburb` と地域のまとまり） |
| `src/ingest.ts` | 日次 cron。直近 6 四半期 × 23 市区町村を XIT001 から取り直す（(市区町村, 年, 四半期) 単位で DELETE→INSERT なので冪等）。5 分おき起動・1 回 3 件に刻む |
| `src/metrics.ts` | 件数・㎡単価中央値・築年帯・価格帯・売りやすさ/貸しやすさスコア（式は画面にも表示）。`scope=city|suburb|all` で範囲を切り替え |
| `src/listing.ts` | 掲載情報（掲載日数・値下げ）用の `ListingSource` / `PagedListingSource` 差し込み口 |
| `src/suumo.ts` / `src/suumo-source.ts` | SUUMO 検索結果 HTML のパーサ・正規化（価格→万円・㎡・築年月・駅/徒歩・市区町村コード）と `SuumoSource` |
| `src/listing-crawl.ts` | 掲載の日次クロール（`LISTINGS_ENABLED=on` のときだけ）。D1 のカーソルで複数起動に分割・止められたら停止・完走回だけ掲載終了 |
| `src/listing-metrics.ts` / `src/listings-dashboard.ts` | `/listings`（非公開）と `/api/listings/metrics`・`/api/listings/status` |
| `src/access.ts` | Cloudflare Access の JWT を Worker 側でも検証（fail-closed） |
| `scripts/access-app.ts` | Access アプリを API で作る（既定 dry-run） |
| `scripts/fake-suumo-server.ts` | ローカル確認用の偽 SUUMO（架空データ） |
| `scripts/backfill.ts` | 過去数年分の一括投入（ローカル実行 → `wrangler d1 execute`） |
| `scripts/load-geo.ts` | 将来推計人口（XKT013・市区町村別に合算）と駅別乗降客数（XKT015） |
| `scripts/estat.ts` | e-Stat の表探し（search / meta）と取り込み（load。定義は `scripts/estat-indicators.json`） |

### 使っている API（2026-09-14 に公式マニュアルで確認）

- XIT001 不動産価格（取引価格・成約価格）: `GET https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001?year&quarter&city` / ヘッダ `Ocp-Apim-Subscription-Key` / gzip JSON `{status, data[]}` / データなしは 404。取引価格 2005Q3〜、成約価格 2021Q1〜
  - `Type = 中古マンション等` だけを保存。中古マンションは `UnitPrice` が空なので ㎡単価 = `TradePrice ÷ Area`
  - **駅距離の項目は無い**（station パラメータで駅単位の取得はできるが未実装）
- XKT013 将来推計人口 250m メッシュ / XKT015 駅別乗降客数: XYZ タイル（`response_format=geojson&z=11..15&x&y`）
- e-Stat API 3.0: `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData` ほか（appId 必須）

### 対象の市区町村コード（2026-09-14 に 2 つの公式資料で突き合わせて確認）

出典: 総務省「全国地方公共団体コード」令和6年1月1日現在（https://www.soumu.go.jp/main_content/000925835.xlsx 、掲載ページ https://www.soumu.go.jp/denshijiti/code.html ）と福岡県「市区町村コード表（福岡県）」（https://www.pref.fukuoka.lg.jp/uploaded/attachment/59124.pdf ）。どちらも 6 桁（末尾は検査数字）で、API には上位 5 桁を使う。

| グループ | 市区町村（5 桁コード） |
|---|---|
| 福岡市（区） | 東区 40131・博多区 40132・中央区 40133・南区 40134・西区 40135・城南区 40136・早良区 40137 |
| 近郊・筑紫地区 | 筑紫野市 40217・春日市 40218・大野城市 40219・太宰府市 40221・那珂川市 40231 |
| 近郊・糸島 | 糸島市 40230 |
| 近郊・宗像・古賀・福津 | 宗像市 40220・古賀市 40223・福津市 40224 |
| 近郊・粕屋郡 | 宇美町 40341・篠栗町 40342・志免町 40343・須恵町 40344・新宮町 40345・久山町 40348・粕屋町 40349 |

DB の列名は歴史的経緯で `ward_code` のまま（市町のコードも入る）。`area_stats.area_level` は `migrations/0002_suburbs.sql` で `ward` → `municipality` に移した。

### cron の容量（無料プランの CPU 10ms 対策）

- 必要数: 直近 6 四半期 × 23 市区町村 = **138 件/日**
- 旧 `*/5 21-22 * * *`（24 回 × 3 件 = 72 件/日）では足りないため、**`*/5 19-23 * * *`（04:00〜08:55 JST・60 回 × 3 件 = 180 件/日）** に広げた。余裕 42 件は失敗の再試行に回る（今日失敗したものは後回しにして、ずっと失敗する件が先頭に居座らないようにしている）
- 1 回あたりの件数（`CRON_BATCH = 3`）は増やしていない。XIT001 は市区町村の全種別を返し、gzip 展開と JSON.parse が CPU を使うため、件数ではなく起動回数で稼ぐ

## セットアップ

```sh
npm ci
cp .dev.vars.example .dev.vars          # REINFOLIB_API_KEY / ESTAT_APP_ID を書く（空でも起動する）
npm run db:migrate:local
npm run dev                             # http://localhost:8787 、cron は /__scheduled
npm run typecheck                       # tsc（Worker・scripts・test）
npm test                                # パーサ・JWT 検証（実ページ由来の分は ~/work/_experiments/listing-probe があるときだけ）
```

掲載クロールをローカルで確かめる（本物の SUUMO には向けない）:

```sh
npm run fake-suumo                                    # 偽サーバ http://127.0.0.1:8790
npx wrangler dev --test-scheduled --var LISTINGS_ENABLED:on --var SUUMO_ORIGIN:http://127.0.0.1:8790 \
  --var LISTINGS_MIN_INTERVAL_MS:0 --var LISTINGS_MAX_PAGES_PER_INVOCATION:10 --var DEV_BYPASS_ACCESS:1
curl "http://localhost:8787/__scheduled?cron=*/20+16-17+*+*+*"   # 1 起動ぶん（取り切るまで繰り返す）
curl -X POST http://127.0.0.1:8790/__day/2                       # 翌日: 消える・値下げ・新着（LISTINGS_TODAY_OVERRIDE も翌日に）
curl -X POST http://127.0.0.1:8790/__mode/429                    # 止まる動作の確認
open http://localhost:8787/listings
```

本番:

```sh
npx wrangler secret put REINFOLIB_API_KEY                  # キー取得後
npm run db:migrate:remote
npm run backfill -- --from 2015 --to 2026 --remote         # 過去分（市区町村×四半期ごとに 300ms 間隔）
npm run backfill -- --from 2015 --to 2026 --scope suburb --remote   # 近郊 16 市町だけ足すとき
npm run load-geo -- --remote                               # 将来人口・駅乗降客数
npm run estat -- search 国勢調査 世帯の家族類型 --statsCode 00200521   # 表を探す
npm run estat -- meta <statsDataId>                        # 分類コードと市区町村コード（抜けも表示）を確かめる
# → scripts/estat-indicators.json を埋めて verified: true にしてから
npm run estat -- load --remote
```

GitHub Actions のシークレット: `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit・D1:Edit）と `CLOUDFLARE_ACCOUNT_ID`。main に push すると型チェック → D1 マイグレーション → デプロイ。

## スコアの考え方

- 順位（パーセンタイル）は表示範囲（福岡市のみ／近郊のみ／すべて）の中で付ける。件数は区・市町の人口規模に左右されるので、「すべて」では価格維持も併せて見る
- **売りやすさ** = 100 ×（0.5 × 流動性の順位 + 0.5 × 価格維持の順位）。流動性 = 直近 8 四半期の件数 ÷ 2、価格維持 = 直近 8 四半期の㎡単価中央値 ÷ その前 8 四半期の中央値。地区は直近 8 件以上・前期 5 件以上のみ
- **貸しやすさ**（市区町村単位）= 取得済み指標のパーセンタイルの加重平均。将来人口増減 20・人口増減(国勢調査) 15・単独世帯割合 20・賃貸用空き家率 25（低いほど良い）・40㎡以下の取引割合 20
- 注意: 取引価格（アンケート）と成約価格（レインズ由来）は同じ取引を重複して含みうるので、既定は取引価格のみ。構成（築年・広さ）の変化で中央値が動くので、比較するときは築年帯・面積フィルタを揃える

## 掲載情報（SUUMO）— 私的利用・既定は無効

**私的・非商用の個人利用に限る**（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止）。許諾契約ではない。
データは非公開の `/listings` でだけ見せ、公開ダッシュボードや API には出さない。robots.txt（2026-09-14）は `/ms/chuko/` を Disallow していない。

### 取り方

- 検索 URL: `https://suumo.jp/ms/chuko/fukuoka/sc_<slug>/?page=N`（1 ページ 20 件・サーバ描画）。物件 ID は `nc_<数字>`
- スラッグは `src/suumo.ts` の `SUUMO_SLUGS`。2026-09-14 に市区町村一覧（`/ms/chuko/fukuoka/city/`）のリンク id と各ページの hidden `sc=<5桁コード>` で 23 件突き合わせた
  - 福岡市: `fukuokashi{higashi,hakata,chuo,minami,nishi,jonan,sawara}`
  - 近郊: `chikushino` `kasuga` `onojo` `dazaifu` `nakagawa` `itoshima` `munakata` `koga` `fukutsu` / 粕屋郡は `kasuyagun` + `umi` `sasaguri` `shime` `sue` `shingu` `hisayama` `kasuya`
  - 久山町は掲載 0 件のため一覧のリンクに出ないが、URL は有効（「条件にあう物件がありません」）
- 件数（2026-09-14）: 福岡市 3,583 件 ≒ 180 ページ + 近郊 851 件 ≒ 51 ページ = **1 日 ≒ 231 ページ**
- 1 ページごとに **6 秒以上**（本番は 5 秒未満にできない）。User-Agent は正直に名乗る（`src/suumo-source.ts`）
- cron `*/20 16-17 * * *`（01:00〜02:40 JST・6 起動）。1 起動 10 分で切り上げ（≒ 80 ページ）→ 3 起動で終わり、残り 3 起動は再開の余裕
- 進み具合は D1 `listing_crawl_cursor` に 1 ページごとに保存（ページの反映とカーソル前進は同じトランザクション）。落ちても次の起動が続きから
- **403 / 429 / 503 / captcha らしき応答 / 一覧の構造が無い** → その日は打ち切り、72 時間クールダウン。`listing_crawl_events` と `/listings` の「クロールの状態」に残る
- 掲載終了は**全市区町村を取り切った回（complete）でだけ**付ける。取れなかった市区町村がある回・見えた件数がヒット件数合計の 85% 未満の回は付けない

### Workers Paid が前提（Free で何が壊れるか）

2026-09 確認の上限: Paid の Cron は CPU 30 秒（1 時間未満間隔）・実行 15 分・サブリクエスト 10,000・D1 クエリ 1,000/起動。

| Free の上限 | 何が起きるか |
|---|---|
| CPU 10ms/起動 | 230KB の HTML を 1〜数ページ解析した時点で超え、起動ごと落ちる（進まない） |
| サブリクエスト 50/起動・D1 クエリ 50/起動 | 1 ページ ≒ 7 クエリなので 1 起動 7 ページ前後で上限 |
| Cron Trigger 数（アカウント合計 5） | この Worker で 2 本使う。他の Worker の cron と合わせて超えるとデプロイが失敗する |

`LISTINGS_ENABLED=off` の間は cron が即 return するので、Free のままマージ・デプロイしても壊れない（ただし cron の本数は数に入る）。

### 非公開にする仕組み（二重）

1. **Cloudflare Access**（カスタムドメイン側）: Self-hosted アプリで `/listings`・`/api/listings` を保護。`scripts/access-app.ts` で作る
   - workers.dev は Access をホスト名単位でしか掛けられず、掛けると公開の `/` まで閉じるので、`/listings` はカスタムドメイン（仮 `condo.kechiiiiin.com`）で見る
2. **Worker 側の JWT 検証**（`src/access.ts`）: `Cf-Access-Jwt-Assertion` を `<team>.cloudflareaccess.com/cdn-cgi/access/certs` の鍵で RS256 検証し、iss・aud・exp と `ALLOWED_EMAILS` を確かめる。
   どれかが未設定なら全員拒否 → workers.dev の `/listings` や Access の設定漏れも 401/403

### 有効化の手順

【Keisuke・ブラウザ】（初回だけ）
1. Workers Paid にアップグレード
2. API トークンを 1 本発行（アカウント: Access: Apps and Policies — Edit / Access: Organizations, Identity Providers, and Groups — Read）。カスタムドメインを wrangler で付けるなら、GitHub Actions 用トークンに Zone: Workers Routes — Edit と DNS — Edit（`kechiiiiin.com`）を足す
3. `/listings` 用のホスト名を決める（仮 `condo.kechiiiiin.com`）

【ヘスティア・コマンド】
```sh
git switch main && git merge --ff-only feat/suumo-listings
# wrangler.toml の [[routes]]（カスタムドメイン）のコメントを外す
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ACCESS_HOSTNAME=condo.kechiiiiin.com ACCESS_EMAILS=<メール> \
  npm run access-app -- --apply            # 表示された CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD を wrangler.toml の [vars] へ
npx wrangler secret put ALLOWED_EMAILS      # /listings を見てよいメール
git push                                    # Actions: 型チェック → テスト → D1 マイグレーション（0003）→ デプロイ（まだ off）
curl -sI https://condo.kechiiiiin.com/listings | head -3                 # 302 → cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code}\n' https://fukuoka-condo-watch.<sub>.workers.dev/listings   # 401
# wrangler.toml の LISTINGS_ENABLED を "on" にして push → 翌 01:00 JST から
npx wrangler tail                            # 初日の様子を見る。/listings の「クロールの状態」でも
```

止めるときは `LISTINGS_ENABLED = "off"` にして push（データは残る）。

## 他のポータル・家賃相場（Data source B）を実装していない理由

各ポータルの利用規約（2026-09-14 確認）:

| サイト | 規約 | 自動取得 |
|---|---|---|
| アットホーム | https://www.athome.co.jp/help/kiyaku.html | 第4条でクローラー等による情報取得を禁止 |
| 不動産ジャパン | https://www.fudousan.or.jp/others/kiyaku.html | 事前同意のないスクレイピングを禁止 |
| 楽待 | https://www.rakumachi.jp/agreement/ | 第10条でクローリング・スクレイピングを禁止 |
| SUUMO | https://cdn.p.recruit.co.jp/terms/suu-t-1003/index.html | 名指しの条項は無いが、私的利用の範囲を超える使用を禁止 → 私的利用に限って上の「掲載情報（SUUMO）」で対応（既定 off） |
| LIFULL HOME'S | https://www.homes.co.jp/kiyaku/ | 名指しの条項は無いが、無断の複製・転載等を禁止 |
| Yahoo!不動産 | https://www.lycorp.co.jp/ja/company/terms/ | LINEヤフーのヘルプでクロール・スクレイピングを禁止と案内 |
| レインズ | 会員（宅建業者）専用 | 個人は利用不可 |

- LIFULL HOME'S データセットは研究機関限定（個人利用不可）
- 許諾された情報源（公式 API・データ提供契約）が見つかったら `src/listing.ts` の `ListingSource` を実装して `ADAPTERS` に登録する。D1 には `listings`・`listing_price_history`・`listing_snapshots`（0001）とクロール状態（0003）を用意済み
- 家賃そのものは公的 API に区単位の粒度が無いため、賃貸需要は人口・世帯・空き家・小型住戸の流通で代わりに見ている

## 出典

このサービスは、国土交通省の不動産情報ライブラリのAPI機能を使用していますが、提供情報の最新性、正確性、完全性等が保証されたものではありません。統計は政府統計の総合窓口（e-Stat）の API を利用しています。

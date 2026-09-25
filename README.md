# fukuoka-condo-watch

福岡市 7 区と福岡都市圏の近郊 16 市町の中古マンション市場を毎日追いかけて、「どこが売りやすいか（流動性・価格維持）」と「どこが貸しやすいか（賃貸需要）」を市区町村・地区ごとに見る Cloudflare Worker。ダッシュボードは「福岡市のみ／近郊のみ／すべて」を切り替え、ランキングは選んだ範囲の中で付ける。

- 公開ダッシュボード（`/`）のデータは公的な公開情報だけ（国土交通省 不動産情報ライブラリ API・e-Stat）
- 掲載情報（SUUMO・私的利用）の取得を同梱（中古は毎日・新築は週 1 回。コードの既定は無効。本番は `LISTINGS_ENABLED=external` = **Keisuke の Mac（launchd）が取って Worker に送る**）。見る画面 `/listings`・`/listings/shinchiku` は Cloudflare Access で非公開。下の「掲載情報（SUUMO）」
- Cloudflare Workers（TypeScript）+ D1 + Cron Trigger。デプロイは手元の `wrangler`（GitHub Actions は型チェックとテストだけ）

## 仕組み

| 部品 | 役割 |
|---|---|
| `src/index.ts` | `/` ダッシュボード、`/api/metrics`（フィルタ付き集計 JSON）、`/api/status`、cron |
| `src/wards.ts` | 対象市区町村の台帳（`AREAS`。区＝`city`・近郊＝`suburb` と地域のまとまり） |
| `src/ingest.ts` | 日次 cron。直近 6 四半期 × 23 市区町村を XIT001 から取り直す（(市区町村, 年, 四半期) 単位で DELETE→INSERT なので冪等）。5 分おき起動・1 回 3 件に刻む |
| `src/metrics.ts` | 件数・㎡単価中央値・築年帯・価格帯・売りやすさ/貸しやすさスコア（式は画面にも表示）。`scope=city|suburb|all` で範囲を切り替え |
| `src/listing.ts` | 掲載情報（掲載日数・値下げ）用の `ListingSource` / `PagedListingSource` 差し込み口 |
| `src/suumo.ts` / `src/suumo-source.ts` | SUUMO 検索結果 HTML のパーサ・正規化（価格→万円・㎡・築年月・駅/徒歩・市区町村コード）と `SuumoSource` |
| `src/suumo-chintai.ts` | SUUMO 賃貸検索結果のパーサ・正規化（賃料・管理費・敷金・礼金・間取り・面積・築年数・沿線/駅・徒歩分・ペット相談可・情報公開日）と `ChintaiSource`。⚠️ 実ページ未検証 |
| `src/suumo-shinchiku.ts` | SUUMO 新築マンション検索結果のパーサ・正規化（価格の幅・未定・予定、面積の幅、引渡時期、販売状況、物件/住戸の別）と `ShinchikuSource` |
| `src/listing-crawl.ts` | 掲載クロールの D1 側。Mac からの取り込み口 `POST /api/ingest/listings`（`external`）と Worker cron での取得（`on`）が同じ関数でカーソルを進める・止められたら停止・完走回だけ掲載終了。種類（中古 `listings` / 新築 `new_listings`）は `ListingStore` で差し替える |
| `src/listing-crawl-core.ts` | Worker と Mac で共有する部品（`LISTINGS_ENABLED` の解釈・種類 `CRAWL_KINDS`・ページ間隔・1 ページ取って振り分け・取り込み要求の検証）。D1 に依存しない |
| `src/ingest-auth.ts` | 取り込み口の Bearer 認証（`LISTINGS_INGEST_TOKEN`・定数時間比較・未設定なら全員拒否） |
| `scripts/suumo-crawl-local.ts` | Mac 側クローラ（`npm run crawl:local`）。launchd（`ops/launchd/`）から中古は毎日 01:00・新築（`--kind shinchiku`）は毎週日曜 06:00 JST |
| `src/listing-metrics.ts` / `src/listings-dashboard.ts` | `/listings`（非公開）と `/api/listings/metrics`・`/api/listings/status` |
| `src/listing-picks.ts` / `src/listing-grouping.ts` / `src/listings-picks-dashboard.ts` | `/listings/picks`・`/api/listings/picks`（非公開）。家族の希望条件（既定 4,800万円以下・70㎡以上・3LDK以上・築25年以内・徒歩10分以内・バス便除外）に合う掲載中の物件を、重複掲載をまとめてカード表示。各カードに価格維持（成約㎡単価の直近2年中央値 ÷ その前2年。住所から起こした町名で地区の値、件数不足なら市区町村の値）。`sort=retention` で価格維持の高い順。**`?kind=rent` で賃貸のタブ**（既定 家賃15万円以下・70㎡以上・3LDK以上・築25年以内、ペット相談可は絞り込みトグル） |
| `src/new-listings.ts` / `src/new-listing-view.ts` / `src/new-listings-dashboard.ts` | `/listings/shinchiku`・`/api/listings/shinchiku`（非公開）。新築の価格幅・㎡単価幅・面積幅・引渡時期・駅徒歩・販売状況・初回掲載日・価格変化と**新築プレミアム**（下の「新築」） |
| `src/access.ts` | Cloudflare Access の JWT を Worker 側でも検証（fail-closed） |
| `scripts/access-app.ts` | Access アプリを API で作る（既定 dry-run） |
| `scripts/fake-suumo-server.ts` | ローカル確認用の偽 SUUMO（架空データ。中古 `/ms/chuko/` と新築 `/ms/shinchiku/`） |
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
# wrangler.toml にカスタムドメインの route があるので --local-upstream が要る。取り込み口は external のときだけ開く
npx wrangler dev --port 8787 --local-upstream 127.0.0.1:8787 \
  --var LISTINGS_ENABLED:external --var LISTINGS_INGEST_TOKEN:local-test-token-0123456789abcdef0123456789 \
  --var SUUMO_ORIGIN:http://127.0.0.1:8790 --var LISTINGS_TODAY_OVERRIDE:2026-09-22 --var DEV_BYPASS_ACCESS:1
# Mac 側クローラ → 取り込み口 → ローカル D1（偽サーバ相手だけ間隔を 0 にできる）
FCW_ENV_FILE=/nonexistent LISTINGS_INGEST_URL=http://127.0.0.1:8787/api/ingest/listings \
  LISTINGS_INGEST_TOKEN=local-test-token-0123456789abcdef0123456789 \
  SUUMO_ORIGIN=http://127.0.0.1:8790 LISTINGS_MIN_INTERVAL_MS=0 npm run crawl:local
# 新築は同じ環境変数で `npm run crawl:local -- --kind shinchiku`（24 ページ。2 日目は価格未定→決定・値下げ・完売・新着）
# 賃貸は `npm run crawl:local -- --kind chintai`（偽サーバは /chintai/fukuoka/sc_<slug>/ も返す。2 日目は値下げ・募集終了・新着）
open http://localhost:8787/listings/shinchiku
curl -X POST http://127.0.0.1:8790/__day/2      # 翌日: 消える・値下げ・新着（wrangler dev の LISTINGS_TODAY_OVERRIDE も翌日にして起動し直す）
curl -X POST http://127.0.0.1:8790/__mode/429   # 止まる動作の確認（Mac 側が 72 時間クールダウンになる）
open http://localhost:8787/listings
# Worker cron で取る旧方式（on）を試すなら: --var LISTINGS_ENABLED:on にして
#   curl "http://localhost:8787/__scheduled?cron=*/15+16-20+*+*+*"
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

GitHub Actions（`.github/workflows/ci.yml`）は push / PR で型チェックとテストだけを行う。Cloudflare のトークンは GitHub に置かない。
デプロイは手元で `npx wrangler d1 migrations apply fukuoka-condo-watch --remote` → `npx wrangler deploy`。

## スコアの考え方

- 順位（パーセンタイル）は表示範囲（福岡市のみ／近郊のみ／すべて）の中で付ける。件数は区・市町の人口規模に左右されるので、「すべて」では価格維持も併せて見る
- **価格の種類の既定は成約価格（`cat=contract`・2021Q1〜）**。国交省 XIT001 の中古マンションは、取引価格（`transaction`）が福岡市の 7 区と春日市にしか無く、近郊の他の市町は成約価格だけ。既定を取引価格にすると近郊の大半が採点できず、春日市だけが別のデータで区と並ぶので、全域にそろっている成約価格を既定にした。取引価格（2015〜）は画面で選べる（福岡市の長期推移を見る用）
- **売りやすさ** = 100 ×（0.5 × 流動性の順位 + 0.5 × 価格維持の順位）。流動性 = 直近 8 四半期の件数 ÷ 2、価格維持 = 直近 8 四半期の㎡単価中央値 ÷ その前 8 四半期の中央値。地区は直近 8 件以上・前期 5 件以上のみ（市区町村より緩い。母数が大きく1件の値動きの影響が小さいため）
  - 「直近」の基準は、選んだ価格の種類で**データのある市区町村数が最近の最大値の半分以上ある最新の四半期**（`src/scoring.ts` の `pickLatestQuarter`）。新しい四半期が一部の市区町村にだけ入った日に、残りの市区町村の直近 8 四半期へ空の四半期が混ざらないようにするため
  - 選んだ価格の種類でスコアが付かない市区町村も表から消さず、理由を出す（API は `sellScore: null` と `sellStatus`）: `no_data`＝**データなし**（直近 16 四半期に 1 件も無い。例: 取引価格を選んだときの近郊、どの種類でも久山町）/ `insufficient`＝**件数不足**（直近か前期が空）/ `few_sales`＝**件数不足（直近◯件）**（直近・前期のどちらかが `MIN_RECENT_SALES`=20 件・`MIN_PRIOR_SALES`=10 件未満。宇美町・須恵町のように年 2〜3 件しか無いと 1 件の値動きでスコアが大きく動くため。本番 D1・成約価格 2026-09-14 時点の分布は 4〜5 件から一気に 30 件へ飛ぶので、その谷間を境目にした）/ `few_candidates`＝**比較対象不足**（範囲内で順位を付けられる市区町村が 3 未満）。これらは順位の母数に入れない（低いスコア扱いにしない）
- **貸しやすさ**（市区町村単位）= 使えた指標のパーセンタイルの加重平均（値の無い指標は除いて重みを割り直す）。将来人口増減 2020→2040 20・人口増減(国勢調査) 15・単独世帯割合 20・賃貸用空き家率 25（低いほど良い）・40㎡以下の取引割合 20・駅乗降客数の増減 2019→最新年 10
  - 使えた指標（`active`）が `MIN_RENT_COMPONENTS`=2 未満、または使えた指標の重み合計が有効指標の合計重みの `MIN_RENT_WEIGHT_SHARE`=50% 未満の市区町村は `rentScore: null`・`rentStatus: "insufficient"`（画面には「材料不足（◯指標）」）とし、順位に入れない。久山町が将来人口 1 本（重み 20）だけで 80 点になっていたのを防ぐため
  - どの指標が効いていて、どれが取り込み待ちかは API の `rentComponentStatus` と画面の「貸しやすさの指標」に出す。e-Stat 由来の 3 指標は、アプリケーション ID の設定と `scripts/estat-indicators.json` の表の検証が済むまで取り込み待ち
  - 将来人口の 2020 年は XKT013 の `PTN_2020`（国勢調査人口）、2025 年以降は `PT00_YYYY`。駅は XKT013 のメッシュ（SHICODE 付き）で市区町村にひも付ける（`station_passengers.area_code`・migrations/0004）
- 注意: 取引価格（アンケート）と成約価格（レインズ由来）は同じ取引を重複して含みうるので、「両方」は重複の恐れがある。構成（築年・広さ）の変化で中央値が動くので、比較するときは築年帯・面積フィルタを揃える

## 掲載情報（SUUMO）— 私的利用・Mac から取る

**私的・非商用の個人利用に限る**（SUUMO ご利用規約 第2条1項「私的利用の範囲」・第3条7号 商業目的の禁止）。許諾契約ではない。
データは非公開の `/listings`（新築は `/listings/shinchiku`・賃貸は `/listings/picks?kind=rent`）でだけ見せ、公開ダッシュボード（`/`・`/api/metrics`）には出さない。robots.txt（2026-09-14）は `/ms/chuko/` と `/chintai/<都道府県>/sc_*/` を、（2026-09-22）は `/ms/shinchiku/<都道府県>/sc_*/` を Disallow していない（Disallow は `brand_list`・`ek_*/null`・`tokushu`・`?*sort=` など。並べ替えのパラメータは付けない）。

### 取る場所（`LISTINGS_ENABLED`）

| 値 | 誰が SUUMO を取るか | 備考 |
|---|---|---|
| `off`（コードの既定・不明な値） | 誰も取らない | cron は D1 にも触らず即 return、取り込み口は 409 |
| `on` | Worker の cron（`*/15 16-20 * * *`） | 2026-09-14〜09-22 の方式。下の経緯でやめた |
| **`external`（本番・2026-09-22〜）** | **Keisuke の Mac（launchd・毎日 01:00 JST）** | cron は取らない。Mac が 1 ページ取るごとに `POST /api/ingest/listings` へ送る |

**Mac へ移した経緯**: Worker の cron から取ると、2026-09-14 に 43 ページ目で 503、9/17・9/20 のクールダウン明けは 1 ページ目で即 503 だった。
Cloudflare Workers の送信元が弾かれている様子で、同じ URL（`/ms/chuko/fukuoka/sc_fukuokashihigashi/`）を自宅回線から curl すると 200・29 件が取れた。

### Mac 側の仕組み

- `scripts/suumo-crawl-local.ts`（`npm run crawl:local`）が、取得・ブロック判定・解析を **Worker cron と同じ関数**（`src/listing-crawl-core.ts` の `fetchAndClassify`）で行い、解析済みの 1 ページぶん（物件 20 件の JSON）を送る
- D1 への反映・カーソル前進・掲載終了の判定は **Worker 側の同じ関数**（`src/listing-crawl.ts` の `applyOutcome` / `finalizeRun`）。Mac は毎回「次にどのページを取るか」を Worker に聞く
  - 送ったページがカーソルの位置と違えば（通信の再送など）反映せず `stale` で今の位置を返す → 二重計上しない
  - Mac が途中で落ちても、翌日（または手動の再実行で）カーソルの続きから。lease は 10 分で解ける
- 取り込み口の認証は **Bearer の共有シークレット**（Worker secret `LISTINGS_INGEST_TOKEN`・32 文字以上・定数時間比較・**未設定なら全員 401**）。Access の JWT 検証（`src/access.ts`）は変えていない
  - 取り込み口は Access の保護パス（`/listings*`・`/api/listings*`）の外の `/api/ingest/listings` に置き、Bearer で守る。Mac は **`https://condo.kechiiiiin.com`** に送る（2026-09-22 にドメインを一本化し workers.dev は無効化）
- クールダウン・最終取得時刻（`listing_crawl_state`）は**取得元ごと**: Worker = `suumo:ms-chuko`、Mac = `suumo:ms-chuko@mac`。
  送信元 IP が違うので、Worker の IP が受けた 503 のクールダウン（2026-09-23T16:15Z まで）で Mac を止めない。Mac が止められたら Mac 側が 72 時間止まる
- 多重起動はロックファイル（`~/.local/state/fukuoka-condo-watch/suumo-crawl.lock`・中身は PID）で防ぐ。**中古・新築・賃貸で同じロック**なので同時に SUUMO を叩かない。
  別の実行が持っていたら、終わるまで最大 6.5 時間待ってから取る（2026-09-22〜。以前はすぐ諦めていた）
- 1 回の上限: 500 ページ・6 時間（通常は ≒ 231 ページ × 61 秒 ≒ 4 時間）
- 置き場所:

| もの | 場所 | 備考 |
|---|---|---|
| トークンと送り先 | `~/.config/fukuoka-condo-watch/env`（chmod 600） | `LISTINGS_INGEST_URL=` と `LISTINGS_INGEST_TOKEN=` の 2 行。plist・リポジトリには書かない |
| launchd | `~/Library/LaunchAgents/com.kechiiiiin.fukuoka-condo-watch.suumo.plist`（中古）・`….suumo-shinchiku.plist`（新築）・`….suumo-chintai.plist`（賃貸） | テンプレートは `ops/launchd/`。`install.sh` が node のパスを埋めて 3 本とも入れる（`--only chuko\|shinchiku\|chintai` で 1 本） |
| ログ | `~/Library/Logs/fukuoka-condo-watch/suumo-crawl.{out,err}.log`・`suumo-shinchiku-crawl.{out,err}.log`・`suumo-chintai-crawl.{out,err}.log` | 1 ページ 1 行 |
| 最後の実行結果 | `/api/listings/status` の `lastLocalRun`（`/listings` の「クロールの状態」にも） | D1 `listing_crawl_events` の kind=`local` |

### 取り方

- 検索 URL: `https://suumo.jp/ms/chuko/fukuoka/sc_<slug>/?page=N`（1 ページ 20 件・サーバ描画）。物件 ID は `nc_<数字>`
- スラッグは `src/suumo.ts` の `SUUMO_SLUGS`。2026-09-14 に市区町村一覧（`/ms/chuko/fukuoka/city/`）のリンク id と各ページの hidden `sc=<5桁コード>` で 23 件突き合わせた
  - 福岡市: `fukuokashi{higashi,hakata,chuo,minami,nishi,jonan,sawara}`
  - 近郊: `chikushino` `kasuga` `onojo` `dazaifu` `nakagawa` `itoshima` `munakata` `koga` `fukutsu` / 粕屋郡は `kasuyagun` + `umi` `sasaguri` `shime` `sue` `shingu` `hisayama` `kasuya`
  - 久山町は掲載 0 件のため一覧のリンクに出ないが、URL は有効（「条件にあう物件がありません」）
- 件数（2026-09-14）: 福岡市 3,583 件 ≒ 180 ページ + 近郊 851 件 ≒ 51 ページ = **1 日 ≒ 231 ページ**
- 1 ページごとに **60 秒**（本番の suumo.jp 相手は 60 秒未満にできない。2026-09-22 に下限を 20 → 30 → 60 秒に上げた。偽サーバ相手だけ短縮可）。User-Agent は正直に名乗る（`src/suumo-source.ts`）
  - 2026-09-14 の初回は 6 秒間隔で 43 ページ目に Cloudflare から 503 を返されたため、時間をかけてでも間隔を広げた（231 ページ ≒ 4 時間）
- （`on` のとき）cron `*/15 16-20 * * *`（01:00〜05:45 JST・20 起動）。1 起動 10 分で切り上げ（≒ 19 ページ）→ 13 起動ほどで終わり、残りは再開の余裕
- 進み具合は D1 `listing_crawl_cursor` に 1 ページごとに保存（ページの反映とカーソル前進は同じトランザクション）。落ちても次の起動が続きから
- **403 / 429 / 503 / captcha らしき応答 / 一覧の構造が無い / 別ホストやボット確認らしき先への 3xx** → その日は打ち切り、72 時間クールダウン。`listing_crawl_events` と `/listings` の「クロールの状態」に残る
- cron が実際に起動した最後の時刻と結果は `/api/listings/status` の `lastCronRun`（`listing_crawl_events` の kind=`cron`。on のときだけ記録）。Mac の実行は `lastLocalRun`
- 掲載終了は**全市区町村を取り切った回（complete）でだけ**付ける。取れなかった市区町村がある回・見えた件数がヒット件数合計の 85% 未満の回は付けない

### 新築（/ms/shinchiku/・週 1 回・2026-09-22〜）

- 検索 URL: `https://suumo.jp/ms/shinchiku/fukuoka/sc_<slug>/?page=N`（1 ページ 30 件・サーバ描画）。スラッグは中古と同じ `SUUMO_SLUGS`（2026-09-22 に `/ms/shinchiku/fukuoka/city/` のリンクと、中央区・春日市・宗像市のページの hidden `sc=<5桁コード>` で一致を確認）
- 件数（2026-09-22）: 福岡市 70 件（中央区 26・博多区 11・南区 9・早良区 9・東区 6・西区 6・城南区 3）+ 近郊 23 件（春日 6・大野城 6・新宮 4・筑紫野 3・太宰府/福津/糸島/那珂川 各 1）= **93 件**。
  どの市区町村も 30 件以下なので **1 回 = 23 ページ ≒ 25 分**（60 秒間隔）。宗像・古賀・粕屋郡の多くは 0 件
- 調べるのに使った本物へのリクエスト: robots.txt・市区町村一覧・中央区・宗像市・中央区 10 件表示の 2 ページ目・春日市の **6 回**（60 秒以上あけた）。保存 HTML は `~/work/_experiments/listing-probe/shinchiku/`（**リポジトリには入れない**。テストは有れば使う）
- 一覧から取れるもの（`src/suumo-shinchiku.ts` 冒頭に構造）:
  - 物件名・所在地・交通（「路線/駅 徒歩N分」。中古の「路線「駅」」とは形が違う）・引渡時期（「2028年7月下旬予定」「即引渡可」「相談」→ `delivery_ym`）
  - 価格は販売期ごとに 1 行（「6590万円～1億2190万円（先着順）」「価格未定（東街区 第7期）」「3800万円台・5500万円台／予定（第2期）」）。全行の最小〜最大を幅にし、**未定は NULL**・予定/「台」は `price_tentative`
  - 間取り・面積の幅（「2LDK・3LDK / 45.59m²～111.59m²」）と、間取りタイプ最大 3 つ（価格と面積の組）→ ㎡単価の幅はタイプの組から、無ければ 価格下限÷面積下限〜価格上限÷面積上限（目安）
  - 販売状況 `sale_status`: 先着順 `first_come`・第N期 `phase`・最終期 `final`・価格未定だけ `upcoming`・表記なしで価格あり `selling`・住戸の掲載 `unit`（表記そのものは `sale_label`）
  - 物件（分譲・`js-keisaiKbn` 3/4）と**住戸単位の掲載**（同じ新築の 1 住戸・`js-keisaiKbn` 8。住所に「福岡県」が付き、引渡は「相談」が多い）が同じ一覧に混ざる → `listing_type` で分ける（中央区は 26 件中 10 件が住戸）
  - ⚠️ 0 件の市区町村のページにも「◯◯に近い新築分譲マンション」として**他の市区町村の物件**が同じ形で並ぶ。件数表示が無く 0 件文言のあるページは物件を読まない
- **一覧に無いもの**: 販売戸数・完成時期（詳細ページにだけある）。取っていない（下の「決めていないこと」）
- D1（`migrations/0005_new_listings.sql`）: `new_listings`（価格・面積・㎡単価は幅、初めて価格が出たときの幅 `first_price_*`、価格変化の回数）と `new_listing_price_history`（初出と、幅が変わった回。未定 → 決定も 1 回）。
  クロールの状態（runs・cursor・state・events）と `listing_snapshots` は取得元 `suumo:ms-shinchiku` で中古と同じ表を使う
- 掲載終了（完売・掲載終了）は中古と同じ考え方: **全市区町村を取り切った回（complete）で 2 回続けて見えなかったら**付ける（週 1 回なので 2 週）。取りこぼし（見えた件数 < ヒット合計の 85%）の回は付けない
- 取り込みは中古と同じ `POST /api/ingest/listings` に `kind: "shinchiku"` を付けて送る（`runId` の取得元と kind が食い違う要求は 400）。解析・ブロック判定は同じ `fetchAndClassify`、反映・カーソル・掲載終了は同じ `applyOutcome` / `finalizeRun`
- 取得元キー: 新築は `suumo:ms-shinchiku@mac`（中古 `suumo:ms-chuko@mac` と別に記録）。ただし送信元は同じ Mac なので、
  **どちらかのキーがクールダウン中なら両方とも取らない**・**ページ間隔の起点はどちらかで最後に取った時刻**（同じ相手に種類を変えて続けて取りに行かない）
- launchd: `com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku`・**毎週日曜 06:00**（中古の 01:00〜≒05:00 と重ならない）。中古が長引いていたらロックで待つ

#### 見る画面（`/listings/shinchiku`・`/api/listings/shinchiku`。Access 保護）

- 物件ごとに価格幅・㎡単価幅・面積幅・間取り・引渡時期・駅徒歩・販売状況・初回掲載日・価格変化（最初の幅 → 今の幅）
- 既定の条件: **価格の下限が 4,800 万円以下・面積の上限が 70㎡以上**（新築は幅があるので「条件に合う住戸がありうる」もの）。価格未定は既定で含める（`undecided=0` で除く）。`all=1` で全件、`type=project|unit`、`muni=`、`ended=1`（掲載終了も）、`sort=newest|premium|price|delivery`
- **新築プレミアム** = 新築の㎡単価（幅の中央。上限が無ければ下限）÷ 同じ地区の**築10年以内の中古の成約㎡単価の中央値（直近 2 年 = 8 四半期）**− 1
  - 分母は国交省 XIT001 の成約価格（`cat=contract`）で、取引年 − 建築年が 0〜10 年の取引。直近の四半期は `pickLatestQuarter` と同じ決め方
  - 地区 = 住所から起こした町名（`districtNameFromAddress`）。地区が 8 件（`MIN_DISTRICT_RECENT_SALES`）未満なら市区町村（20 件 = `MIN_RECENT_SALES`）、それも足りなければ出さない
  - 価格未定の物件には出ない。㎡単価が「価格幅 ÷ 面積幅」の目安のときは分子も目安

#### 決めていないこと（新築）

- **販売戸数・完成時期**: 一覧に無い。取るなら詳細ページ（`nc_<id>/`）を物件ごとに 1 回（今は ≒ 90 回/週 = +90 分）。いまは取らず、画面にも「取っていない」と出している。選択肢: 取らない（現状）／新着の物件だけ詳細を 1 回取る／全件を月 1 回
- **物件と住戸の掲載の重複**: 同じ建物が「物件」と「住戸」の両方で出る（パークホームズ大濠公園ミッド等）。いまはまとめず、種別バッジで区別して並べるだけ
- **プレミアムの分母の件数**: 築10年以内に絞ると近郊の市町は 20 件に届かないことが多い（届かなければ出さない）。閾値を下げるかは実データを見てから
- **クールダウンの共有**: 中古と新築のどちらかが止められたら両方止める（送信元が同じため）。依頼は「取得元キーを別に」だったので、キーは別に記録したうえでこうしている。分けて運用したくなったら `src/listing-crawl.ts` の `ALL_LOCAL_STATE_KEYS` を外す

### 賃貸（/chintai/・週 1 回・2026-09-26〜）

⚠️ **実ページ未検証**: 追加にあたって本番 SUUMO には一度もアクセスしていない（テストはローカルの偽サーバと固定 HTML）。
下のうち「未検証」と書いたものは、初回のクロール前に 1 リクエストずつ確かめること（60 秒以上あける）。

- 検索 URL: `https://suumo.jp/chintai/fukuoka/sc_<slug>/?<絞り込み>&page=N`。物件 ID は `jnc_<数字>`（一覧の「詳細を見る」リンク）
  - スラッグは中古・新築と同じ `SUUMO_SLUGS`（**未検証**。`/chintai/fukuoka/city/` のリンクと hidden `sc=<5桁コード>` で突き合わせること）
  - robots.txt（2026-09-14 取得の保存分）の `User-agent: *` は `/chintai/<都道府県>/sc_*/` を Disallow していない
    （Disallow は `/chintai/bc_*/printout/`・`/chintai/*/__JJ_*`・`/chintai/*/city/?sc[]=`・`/*?*sort=` など）。**並べ替えのパラメータは付けない**
- **取得時に絞り込む**（`src/suumo-chintai.ts` の `CHINTAI_QUERY`）: 賃料 20 万円以下（`ct`）・専有面積 60㎡ 以上（`mb`）・間取り 3K〜5K以上（`md`）。
  福岡都市圏の賃貸は全部で数万件あり、60 秒間隔では 1 週間かかっても終わらないため。画面の既定条件（家賃 15 万円以下・70㎡以上・3LDK 以上・築 25 年以内）より少し広く取り、
  画面側の絞り込みはこの範囲の中で効く。**この範囲の外は画面の条件を広げても出てこない**（画面の注記にも出している）。パラメータ名と値は **未検証**
- 1 行 = 1 部屋（`listings` に `kind = 'rent'` で入れる。`current_price` = 月額賃料・円）。1 つの建物（`cassetteitem`）に複数の部屋が並ぶ
- 一覧から取るもの: 月額賃料・管理費/共益費・敷金・礼金・専有面積・間取り・築年数（→ 建築年）・住所・沿線/駅・徒歩分・**ペット相談可**・情報公開日
  - 敷金・礼金が「◯ヶ月」表記のものは 賃料 × 月数 で円に直す（賃料が読めないときは NULL。推測で埋めない）。「-」「なし」は 0
  - ペット相談可は一覧の文言（「ペット相談」「ペット可」「ペット飼育可」）から。「ペット不可」「ペット相談不可」は false。**どこに出るかは未検証**なので、建物・部屋どちらのブロックに出ても拾えるよう文言で探している
  - 件数表示のクラス名（`paginate_set-hit` / `pagination_set-hit`）も **未検証**。両方を見ている
- ページ数は「件数表示 ÷ 30」。件数表示が部屋数で 1 ページが建物 30 件なら**多めに見積もる**側に倒れる（足りないより安全。余ったページは空ページで `done` になる）
- D1（`migrations/0006_listings_rent.sql`）: `listings` に `admin_fee`・`deposit`・`key_money`・`pets_allowed`・`listed_on` を足しただけ（**追加のみ**）。
  クロールの状態（runs・cursor・state・events）と `listing_snapshots` は取得元 `suumo:chintai` で中古と同じ表を使う
- 取り込みは中古・新築と同じ `POST /api/ingest/listings` に `kind: "chintai"` を付けて送る。
  **取得元ごとに許す `listings.kind`** は `src/listing-crawl-core.ts` の `CRAWL_KINDS[kind].listingKind`（中古 = `sale`・賃貸 = `rent`・新築 = `null`）。食い違う要求は 400
- 取得元キー: `suumo:chintai@mac`（中古・新築と別に記録）。ただし送信元は同じ Mac なので、**どれかがクールダウン中なら全部取らない**・**間隔の起点はどれかで最後に取った時刻**
- launchd: `com.kechiiiiin.fukuoka-condo-watch.suumo-chintai`・**毎週土曜 06:00**（中古の 01:00〜≒05:00 とも新築の日曜 06:00 とも重ならない）。3 本とも同じロックファイル
- 1 回の上限: 200 ページ・5 時間

#### 見る画面（`/listings/picks?kind=rent`。Access 保護）

売買（中古）と同じ `/listings/picks` にタブを足した（既定は従来どおり売買。`?kind=rent` で賃貸）。

- 既定の条件: **家賃 15 万円以下・70㎡以上・3LDK 以上・築 25 年以内**。徒歩分は指定なし・バス便も含む（依頼に無い条件で勝手に狭めない）
- **ペット相談可は絞り込みトグル**（既定 OFF = 絞らない。`pets=1` で相談可だけ）。カードには常に「ペット相談可」バッジを出す
- カード: 賃料（幅）・管理費・敷金・礼金・間取り・面積・築年・沿線/駅・徒歩分・掲載開始・情報公開日・貸しやすさ（市区町村）
- 重複のまとめ方は売買と同じ（建物名 + 間取り + 築年 + 面積 ±0.5㎡）。⚠️ 賃貸は同じ建物の**別の部屋**がまとまることがある（画面に注記あり）
- 価格維持・売出/成約比は売買の指標なので賃貸では出さない

#### 決めていないこと（賃貸）

- **実ページの構造の確認**: 上の「未検証」5 点。初回クロールの前に確かめる（確かめるまでは本番で走らせない）
- **取得時の絞り込みの幅**: いまは賃料 20 万円・60㎡・3K 以上。広げるとページ数（＝時間）がそのまま増える。実件数を見てから決める
- **重複のまとめ方**: 売買のロジックを使い回している。別の部屋が 1 枚になる問題を直すなら、部屋の階を取って鍵に足す
- **募集終了の判定**: 中古・新築と同じ（完走回で 2 回続けて見えなかったら）。賃貸は入れ替わりが速いので、週 1 回では 2 週かかる

### Workers Paid が前提（Free で何が壊れるか）

※ `external`（Mac 方式）では解析は Mac 側で済み、取り込みは 1 リクエスト = 1 ページ（D1 ≒ 10 クエリ）なので、下の cron の上限には当たらない。以下は `on` のときの話。

2026-09 確認の上限: Paid の Cron は CPU 30 秒（1 時間未満間隔）・実行 15 分・サブリクエスト 10,000・D1 クエリ 1,000/起動。

| Free の上限 | 何が起きるか |
|---|---|
| CPU 10ms/起動 | 230KB の HTML を 1〜数ページ解析した時点で超え、起動ごと落ちる（進まない） |
| サブリクエスト 50/起動・D1 クエリ 50/起動 | 1 ページ ≒ 7〜8 クエリなので 1 起動 6 ページ前後で上限 |
| Cron Trigger 数（アカウント合計 5） | この Worker で 2 本使う。他の Worker の cron と合わせて超えるとデプロイが失敗する |

`LISTINGS_ENABLED=off` の間は cron が即 return するので、Free のままマージ・デプロイしても壊れない（ただし cron の本数は数に入る）。

### 非公開にする仕組み（二重）

1. **Cloudflare Access**（カスタムドメイン側）: Self-hosted アプリで `/listings`・`/api/listings` を保護。`scripts/access-app.ts` で作る
   - workers.dev は Access をホスト名単位でしか掛けられず、掛けると公開の `/` まで閉じるので、`/listings` はカスタムドメイン（仮 `condo.kechiiiiin.com`）で見る
2. **Worker 側の JWT 検証**（`src/access.ts`）: `Cf-Access-Jwt-Assertion` を `<team>.cloudflareaccess.com/cdn-cgi/access/certs` の鍵で RS256 検証し、iss・aud・exp と `ALLOWED_EMAILS` を確かめる。
   どれかが未設定なら全員拒否 → workers.dev の `/listings` や Access の設定漏れも 401/403

### Mac 方式のセットアップ（2026-09-22〜）

【Keisuke・ブラウザ】**なし**（Access・Workers Paid・カスタムドメインは 2026-09-14 に済んでいる。トークンは CLI で生成して secret に入れる）

新築（週 1 回）を足すとき（2026-09-22〜。トークン・env は中古と共用なので新しい設定は要らない）:
```sh
git push                                                   # main を push
npx wrangler d1 migrations apply fukuoka-condo-watch --remote   # 0005_new_listings
npx wrangler deploy
bash ops/launchd/install.sh                                # 2 本とも入れ直し（中古も node のパスを埋め直すだけ。--only shinchiku で新築だけ）
npm run crawl:local -- --kind shinchiku --dry-run          # 取得先 https://suumo.jp・間隔 60000ms
launchctl kickstart gui/$(id -u)/com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku   # 初回を今すぐ（≒ 25 分。中古の実行中なら終わるまで待つ）
tail -f ~/Library/Logs/fukuoka-condo-watch/suumo-shinchiku-crawl.out.log
```

【ヘスティア・コマンド】（Mac のターミナルで。トークンの値は画面に出ない）
```sh
cd ~/work/fukuoka-condo-watch && npm ci
npx wrangler deploy                       # LISTINGS_ENABLED=external と取り込み口。（workers.dev は無効。`workers_dev = false`）
bash ops/setup-ingest-token.sh https://condo.kechiiiiin.com
                                          # トークン生成 → wrangler secret put（stdin）→ ~/.config/fukuoka-condo-watch/env（600）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://condo.kechiiiiin.com/api/ingest/listings   # 401（認証なしは拒否）
npm run crawl:local -- --dry-run          # 設定の確認だけ（取得先 https://suumo.jp・間隔 60000ms と出る）
bash ops/launchd/install.sh               # launchd に登録（毎日 01:00。入れた瞬間には走らない）
npm run crawl:local -- --max-pages 2      # 試し走り: 2 ページ（≒ 1 分）で切り上げ。続きはカーソルから
launchctl kickstart gui/$(id -u)/com.kechiiiiin.fukuoka-condo-watch.suumo   # 通しの初回を今すぐ（≒ 4 時間）
tail -f ~/Library/Logs/fukuoka-condo-watch/suumo-crawl.out.log
```

止めるとき: `bash ops/launchd/uninstall.sh`（データ・ログ・env は残る）。Worker 側も閉じるなら `LISTINGS_ENABLED = "off"` にして deploy。
トークンを替えるとき: `bash ops/setup-ingest-token.sh <同じ URL>` をもう一度（secret と env の両方が新しい値になる）。
Mac 側のクールダウンを手で解くとき（原因が分かって解消したときだけ）:
`npx wrangler d1 execute fukuoka-condo-watch --remote --command "UPDATE listing_crawl_state SET cooldown_until = NULL WHERE source = 'suumo:ms-chuko@mac'"`

### 初回の有効化の手順（2026-09-14・Worker cron 方式のとき。記録として残す）

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
npx wrangler d1 migrations apply fukuoka-condo-watch --remote && npx wrangler deploy   # 0003 → デプロイ（まだ off）
curl -sI https://condo.kechiiiiin.com/listings | head -3                 # 302 → cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code}\n' https://condo.kechiiiiin.com/listings   # 302（Access）
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

# JAPAN LIVE

**日本リアルタイム・デジタルツイン。** 日本列島を3Dで眺め、東京にズームすると
実際の街が現れ、その中を電車が動いている——それを眺めること自体が楽しい、という
プロダクトです。乗換案内でも、運行情報サイトでもありません。

**現在のバージョン: V1.1 — TOKYO TRAINS + Visual Foundation**

---

## いま何ができるか

- 宇宙から見た日本列島。現在時刻に合わせた昼夜表現
- 日本全国の3D地形（PLATEAU Terrain）
- 東京へのシームレスなズーム
- **東京23区の3D建物**（PLATEAU 3D Tiles、カメラ位置に応じて近い区だけ読み込み）
- **PLATEAU Buildings 診断パネル**（取得元・読込区数・表示状態・カメラ高度・LOD・失敗URL）
- **CITY VIEW** — 3D都市が最も分かる斜め視点プリセット
- 都営地下鉄4路線 + 東京メトロ9路線の路線・駅
- 路線形状の上を動く列車（直線ではなく実際の線形に沿って移動）
- **データ種別（DataMode）の明示** — リアルタイム / 時刻表 / 模擬 の区別
- 地下鉄 X-RAY 表示
- LIVE モード / SIMULATION モード（×1 / ×10 / ×60 / ×600）
- 時刻スライダー（04:00〜26:00）
- 列車クリック → Inspector → FOLLOW（カメラ追従）
- カメラプリセット（日本 / 関東 / 東京 / 東京駅 / 新宿 / 渋谷）と TOUR
- 駅・路線の検索
- データ出典の常時表示

### V1 でやらないこと

バス・飛行機・船・人流・自動車・高度な天候・災害・全国鉄道網・全私鉄・
写実的な列車モデル。これらは V2〜V4 です（[docs/ROADMAP.md](docs/ROADMAP.md)）。

---

## 「リアルタイム」を捏造しない

このプロジェクトで最も重要なルールです。すべての移動体が `DataMode` を持ちます。

| DataMode | 意味 |
| --- | --- |
| `REALTIME_POSITION` | 事業者が緯度経度を配信している（実測位置） |
| `REALTIME_TRIP` | リアルタイムの駅間情報。**緯度経度は配信されていない** |
| `REALTIME_STATUS` | 遅延・運休などの状況のみ |
| `SCHEDULE_INTERPOLATED` | 時刻表から推定した位置 |
| `SIMULATED` | アプリ内で生成した模擬データ |
| `HISTORICAL` | 過去データの再生 |
| `UNAVAILABLE` | データなし |

**V1 で `REALTIME_POSITION` を出すデータ源はひとつもありません。** 都営地下鉄の
`odpt:Train` は「どの駅とどの駅の間にいるか」を配信しますが、座標は配信しません。
したがって `REALTIME_TRIP` であり、画面上の点は**こちらが路線形状の上に補間したもの**
です。Inspector はその両方を明示します。

古くなったデータは自動的に格下げされます（90秒で STALE、5分で時刻表ベースへ、
15分で表示をやめる）。**古いデータを LIVE のまま表示し続けることはありません。**

---

## DEMO MODE で起動する（APIキー不要）

何も設定せずに動きます。GitHub Pages に公開されるのもこの状態です。

```bash
npm install
npm run dev
# http://localhost:5173
```

模擬データで13路線・約360本の列車が動きます。画面には常時
**DEMO / SIMULATED DATA** と表示され、実在の列車ではないことが明示されます。

---

## ローカル開発

```bash
npm install          # 依存関係
npm run dev          # フロントエンド (http://localhost:5173)
npm run dev:gateway  # ゲートウェイ (別ターミナル、任意)
npm test             # ユニットテスト
npm run typecheck    # 型チェック
npm run e2e          # E2E (要 npx playwright install chromium)
npm run build        # 本番ビルド
npm run data:demo    # デモデータセットを再生成
npm run data:gtfs    # ODPT から実データセットを生成（要 APIキー）
npm run data:plateau # PLATEAU 公式カタログから 3D建物 manifest を再生成
```

---

## LIVE データに切り替える

LIVE にするには ODPT のキーが要ります。**キーはブラウザに渡しません。**
ゲートウェイ（Cloudflare Worker）がサーバー側で保持します。

### 1. ODPT に登録してキーを取得

https://developer.odpt.org/ で開発者登録し、アクセストークンを取得します。

### 2. ゲートウェイをデプロイ

```bash
cd apps/gateway
npx wrangler login
npx wrangler secret put ODPT_CONSUMER_KEY   # ここでキーを貼り付ける
```

`apps/gateway/wrangler.toml` の `ALLOWED_ORIGINS` を自分のサイトのオリジンに
変更してから:

```bash
npx wrangler deploy
```

### 3. フロントエンドをゲートウェイに向ける

`apps/web/.env.local` を作成:

```
VITE_GATEWAY_URL=https://japan-live-gateway.<your-subdomain>.workers.dev
```

これで DEMO バッジが消え、都営地下鉄が `REALTIME_TRIP` で表示されます。

### 4. （任意）実際の路線・時刻表データに差し替える

```bash
ODPT_CONSUMER_KEY=xxxx npm run data:gtfs
```

`apps/web/.env.local` に `VITE_DATASET_URL=data/odpt-dataset.json` を追加します。
これでデモの概算形状ではなく、ODPT の実データで動きます。

---

## GitHub Pages に公開する

1. リポジトリの **Settings → Pages → Source** を **GitHub Actions** に設定
2. `main` に push

`.github/workflows/deploy-pages.yml` がビルドして公開します。既定では
**DEMO MODE**（認証情報なし）で公開されます。LIVE で公開したい場合は
リポジトリ変数 `VITE_GATEWAY_URL` を設定してください
（Settings → Secrets and variables → Actions → Variables）。

---

## 必要な Secrets / 変数

| どこに | 名前 | 何のため | 必須 |
| --- | --- | --- | --- |
| Cloudflare Worker secret | `ODPT_CONSUMER_KEY` | ODPT 認証。**ブラウザには絶対に渡らない** | LIVE のみ |
| `wrangler.toml` `[vars]` | `ALLOWED_ORIGINS` | CORS 許可オリジン（ワイルドカード禁止） | LIVE のみ |
| GitHub Actions variable | `VITE_GATEWAY_URL` | 公開ビルドを LIVE にする | 任意 |
| シェル環境変数 | `ODPT_CONSUMER_KEY` | `npm run data:gtfs` 用 | 任意 |

`.env.example` を参照してください。`VITE_` 変数は**公開バンドルに埋め込まれます**。
秘密情報を入れてはいけません。

---

## 3D建物が表示されないときは

画面右の **PLATEAU BUILDINGS** パネルが理由を表示します。

| 表示 | 意味と対処 |
| --- | --- |
| `カメラが高すぎます` | 建物は高度12km以下で読み込まれます。「東京」か「CITY VIEW」を押してください |
| `ERROR` + 失敗URL | 「詳細ログ」を開くと失敗した URL と HTTP ステータスが確認できます |
| `Manifest (公式URL規則から生成)` | まだ公式カタログに問い合わせていない状態です。`npm run data:plateau` で実URLに更新できます |
| `一部のみ` | 一部の区だけ読み込めています。端末負荷を抑えるため近い区のみを読み込む設計です |

## データ出典

すべて [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) に記録しています。

- **地形 / 3D都市モデル**: Project PLATEAU（国土交通省） / 国土地理院（承認番号 R3JHs 778）
- **ベースマップ**: 地理院タイル（国土地理院）
- **運行データ**: 公共交通オープンデータセンター / 東京都交通局 / 東京地下鉄
- **デモデータ**: 本リポジトリ生成の模擬データ（実データではありません）

ライセンス上必要な帰属表示は画面右下に常時表示しています。

---

## 現在の制約

- **`REALTIME_POSITION` は V1 に存在しません。** 対象データ源が座標を配信していないためです
- **JR東日本は無効化されています。** 利用条件を確認できていないため（[docs/DECISIONS.md](docs/DECISIONS.md) D-007）
- **デモデータの路線形状は概算です。** 手作業で作成したもので測量データではありません。`npm run data:gtfs` で置き換わります
- 東京メトロの位置は時刻表ベースです（運行情報のみリアルタイム）
- 3D建物は東京23区のみ
- 開発環境の制約により、**PLATEAU の実タイル取得は未検証**です。ビルド環境から `*.mlit.go.jp` に到達できないためで、描画パイプライン自体は実際の3D Tilesフィクスチャで検証済みです（[docs/DECISIONS.md](docs/DECISIONS.md) D-001, D-012）
- PLATEAU の CORS 許可オリジンはデプロイ時設定のため未確認です。manifest は composite URL と CDN 直リンクの両方を保持し順に試行します

---

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 構成、DataMode の流れ、描画モデル、障害時の挙動 |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | 全データ源の監査結果（ライセンス・更新頻度・DataMode） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | V1〜V4 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 設計判断とその理由 |
| [docs/V2_PLAN.md](docs/V2_PLAN.md) | V2 実装計画 |

## 構成

```
apps/web        React + TypeScript + Vite + CesiumJS
apps/gateway    Cloudflare Worker（APIキー秘匿・CORS・キャッシュ・レート制御）
packages/shared      DataMode, MobilityEntity, Provider 契約
packages/core        測地計算, JST/サービス日, 路線形状インデックス, 補間曲線
packages/transit     静的路線モデル, 時刻表補間, 平滑化
packages/providers    Toei / TokyoMetro / JREast / Demo
packages/simulation  シミュレーション時計とエンジン
scripts/data         データセット生成
```

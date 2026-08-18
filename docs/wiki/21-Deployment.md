# 21. デプロイメント

LINE Harness のローカル開発、本番デプロイ、CI/CD の完全ガイド。

---

## プロジェクト構成

```
line-harness/
├── apps/
│   ├── worker/        # Cloudflare Workers API サーバー + LIFF フロントエンド
│   └── web/           # Next.js 管理パネル
├── packages/
│   ├── db/            # D1 データベースクエリ + schema.sql
│   ├── sdk/           # @line-harness/sdk (TypeScript SDK)
│   ├── line-sdk/      # LINE Messaging API クライアント
│   └── shared/        # 共有型定義
├── pnpm-workspace.yaml
└── package.json
```

パッケージマネージャー: **pnpm 9.15.4**
Node.js: **>= 20**

---

## ローカル開発セットアップ

### 前提条件

- Node.js >= 20
- pnpm >= 9
- Cloudflare アカウント
- LINE Developers アカウント

### 初期セットアップ

```bash
# リポジトリクローン
git clone https://github.com/your-org/line-harness.git
cd line-harness

# 依存インストール
pnpm install

# パッケージビルド
pnpm -r build

# ローカル D1 データベース作成 + マイグレーション
pnpm db:migrate:local
```

### Worker 開発サーバー

```bash
pnpm dev:worker
# => wrangler dev (http://localhost:8787)
```

ローカルでは `.dev.vars` ファイルに環境変数を設定:

```ini
# apps/worker/.dev.vars
LINE_CHANNEL_SECRET=your-channel-secret
LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token
API_KEY=dev-api-key
LIFF_URL=https://liff.line.me/YOUR_LIFF_ID
LINE_CHANNEL_ID=your-channel-id
LINE_LOGIN_CHANNEL_ID=your-login-channel-id
LINE_LOGIN_CHANNEL_SECRET=your-login-channel-secret
```

### 管理パネル開発

```bash
pnpm dev:web
# => next dev (http://localhost:3000)
```

`apps/web/src/lib/api.ts` でAPI URLを設定。

---

## Cloudflare Workers デプロイ

### 手動デプロイ

```bash
# 1. パッケージビルド
pnpm -r build

# 2. Worker デプロイ
pnpm deploy:worker
# => wrangler deploy (apps/worker/)
```

### wrangler.toml 設定

```toml
name = "your-worker-name"
main = "src/index.ts"
compatibility_date = "2024-12-01"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "line-crm"
database_id = "YOUR_D1_DATABASE_ID"

[triggers]
crons = ["*/5 * * * *"]
```

- `workers_dev = true` で `*.workers.dev` サブドメインが自動割当
- cron は 5分毎に実行 (ステップ配信、予約配信、リマインダー、ヘルスチェック)

### シークレット設定

**絶対に wrangler.toml にシークレットを書かないこと。**

```bash
wrangler secret put API_KEY
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put LINE_CHANNEL_ID
wrangler secret put LINE_LOGIN_CHANNEL_ID
wrangler secret put LINE_LOGIN_CHANNEL_SECRET
wrangler secret put LIFF_URL

# オプション
wrangler secret put STRIPE_WEBHOOK_SECRET
```

---

## GitHub Actions 自動デプロイ

`.github/workflows/deploy-cloudflare.yml` に設定済み。

### トリガー条件

`main` または `dev` ブランチへの push で、以下のパスに変更がある場合に実行:
- `apps/worker/**`
- `packages/db/**`
- `packages/shared/**`
- `packages/line-sdk/**`
- `apps/liff/**`
- `apps/web/**`
- `.github/workflows/deploy-cloudflare.yml`

### ワークフロー内容

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-crm/db build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/worker
          command: deploy
```

### 必要な GitHub Secrets

| シークレット名 | 取得方法 |
|--------------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard > My Profile > API Tokens > Create Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard > Workers > Account ID |

---

## 管理パネル デプロイ (Cloudflare Pages)

```bash
# 1. ビルド
pnpm deploy:web
# => next build (apps/web/)

# 2. Cloudflare Pages にデプロイ
# Dashboard から GitHub リポジトリを接続、または:
wrangler pages deploy apps/web/out --project-name=your-admin-name
```

### Pages 設定

- ビルドコマンド: `pnpm install && pnpm -r build && pnpm --filter web build`
- 出力ディレクトリ: `apps/web/out`
- Node.js バージョン: 22

---

## LIFF 配信

標準機能のLIFFはWorker Assetsとして配信できます。一方、薬局カスタム機能
（`apps/liff` の `pharmacy-*` 画面）は共有Workerとは分離した専用Cloudflare Pagesへ
配信します。薬局のLIFF endpointをWorkerルートへ向けると、Workerの汎用クライアントが
表示され、処方せん画面へ接続できません。

薬局カスタムでは、WorkerはAPIとWebhook、LIFF Pagesは患者向け画面を担当します。
GitHub Actionsの顧客デプロイが両方のPagesを更新します。

### 薬局LIFFのビルド時環境変数

共有デプロイ時に以下の値が必要です。テナント固有のLIFF IDはビルドへ埋め込まず、
入口URLの`?liffId=`から実行時に解決します。

| 変数名 | 説明 |
|--------|------|
| `VITE_API_BASE` | 薬局LIFF Pagesが呼び出す共有Worker URL |

### LIFF エンドポイント URL

標準機能のLIFFエンドポイント URLはWorker URLを使用できます（薬局機能には使用しません）:
```
https://line-harness.your-account.workers.dev
```

薬局カスタムのLIFFエンドポイントは専用Pages URLを使用します:
```
https://your-pharmacy-liff.pages.dev/?liffId=your-liff-id
```

共有デプロイでは、LIFF PagesのHTMLが参照する実JSを取得し、マルチテナント用ビルド
マーカー、薬局受付ルート、共有Worker URLを検査します。Adminの`/accounts`が参照する
JSにも専用LIFF Pages URLが含まれることを検査します。HTTP 200だけで古い汎用bundleを
成功扱いにしないためのゲートです。LINE Developers Consoleの各LIFFアプリは、薬局固有
の入口として次のURLを登録してください:

```
https://<LIFF_ORIGIN>/?liffId=<そのテナントのLIFF ID>
```

`liffId`を省略したURLやWorker URLを登録してはいけません。

---

## D1 データベースマイグレーション

### リモート (本番)

```bash
pnpm db:migrate
# => wrangler d1 execute your-database --file=packages/db/schema.sql
```

### ローカル

```bash
pnpm db:migrate:local
# => wrangler d1 execute your-database --file=packages/db/schema.sql --local
```

スキーマは `CREATE TABLE IF NOT EXISTS` を使用しているため、冪等に実行可能。既存テーブルはスキップされる。

### D1 データベース作成 (初回のみ)

```bash
wrangler d1 create line-crm
# => database_id が出力される → wrangler.toml に記入
```

---

## 環境変数チェックリスト

### Worker (必須)

| 変数名 | 説明 | 設定方法 |
|--------|------|----------|
| `DB` | D1 バインディング | wrangler.toml |
| `API_KEY` | REST API 認証キー | `wrangler secret put` |
| `LINE_CHANNEL_SECRET` | Messaging API チャネルシークレット | `wrangler secret put` |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API アクセストークン | `wrangler secret put` |
| `LIFF_URL` | LIFF アプリ URL | `wrangler secret put` |
| `LINE_CHANNEL_ID` | Messaging API チャネルID | `wrangler secret put` |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login チャネルID | `wrangler secret put` |
| `LINE_LOGIN_CHANNEL_SECRET` | LINE Login チャネルシークレット | `wrangler secret put` |

### Worker (オプション)

| 変数名 | 説明 | 設定方法 |
|--------|------|----------|
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名検証キー | `wrangler secret put` |

### 薬局カスタム（GitHub Actions環境変数）

| 変数名 | 説明 |
|--------|------|
| `LIFF_PAGES_PROJECT` | 薬局カスタムLIFF Pagesプロジェクト名 |
| `LIFF_ORIGIN` | 薬局カスタムLIFF Pagesの公開URL（Worker CORS許可元） |
| `WORKER_URL` | 薬局カスタムLIFFが呼び出すWorker URL |

---

## DNS / ドメイン設定

### workers.dev サブドメイン (デフォルト)

`workers_dev = true` の場合、自動的に割り当てられる:
```
https://your-worker-name.{account}.workers.dev
```

### カスタムドメイン

1. Cloudflare Dashboard > Workers > Custom Domains
2. ドメインを追加
3. DNS レコードが自動設定される

または wrangler.toml:
```toml
routes = [
  { pattern = "api.yourdomain.com", custom_domain = true }
]
```

### LINE Webhook URL 設定

LINE Developers Console > Messaging API > Webhook URL:
```
https://your-worker.your-subdomain.workers.dev/webhook
```

---

## コスト概算

### Cloudflare Workers Free Tier

| リソース | 無料枠 | 説明 |
|---------|--------|------|
| リクエスト | 100,000/日 | Worker 呼び出し数 |
| D1 読み取り | 5,000,000/日 | DB クエリ数 |
| D1 書き込み | 100,000/日 | DB 変更数 |
| D1 ストレージ | 5GB | DB サイズ |
| Cron | 無制限 | 5分毎の定期実行 |

### 有料 (Workers Paid / $5/月)

| リソース | 有料枠 |
|---------|--------|
| リクエスト | 10,000,000/月 (以降 $0.30/100万) |
| D1 読み取り | 25,000,000,000/月 |
| D1 書き込み | 50,000,000/月 |
| D1 ストレージ | 5GB (以降 $0.75/GB) |

### LINE Messaging API

| プラン | 無料メッセージ | 追加メッセージ |
|--------|-------------|-------------|
| コミュニケーション | 200/月 | 不可 |
| ライト | 5,000/月 | 不可 |
| スタンダード | 30,000/月 | ~3円/通 |

### 目安

- 友だち 1,000 人以下: Cloudflare 無料枠 + LINE スタンダードで月額 ~15,000 円
- 友だち 10,000 人以下: Cloudflare $5/月 + LINE スタンダード
- L社/U社 の月額 30,000円〜と比較して大幅にコスト削減可能

---

## デプロイ後の確認

```bash
# API ヘルスチェック
curl https://your-worker.your-subdomain.workers.dev/openapi.json

# 認証テスト
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://your-worker.your-subdomain.workers.dev/api/friends/count

# Swagger UI
open https://your-worker.your-subdomain.workers.dev/docs
```

---

## 既存環境のマイグレーション（共有マルチテナントLIFF）

薬局LIFFフロントエンドは共有Workerから分離した専用Pagesへ配信します。WorkerはAPIと
Webhookを担当し、全テナントが同じWorkerへ接続します。既存のD1・R2・LINE資格情報は
デプロイ時の保護チェックで保持されます。

### 手順

1. **リポジトリを最新に更新**

```bash
git pull origin main && pnpm install
```

2. **共有Worker・LIFF Pages・Adminを同じcommitで更新**

```bash
git push origin dev   # GitHub Actionsのdevelopment環境で確認
```

3. **LINE Developers Consoleで各テナントのLIFFエンドポイントURLを確認**
   - LINE Login チャネル → LIFF タブ → エンドポイント URL
   - `https://<LIFF_ORIGIN>/?liffId=<テナントのLIFF ID>`
   - Worker URLを設定しない

4. **LINE上のリッチメニューは明示的に公開・初期表示設定**
   - 管理画面の`prepare`はD1/R2の下書き作成だけです。
   - `LINEに登録`後、必要に応じて`初期表示に設定`または`友だちに表示`を実行します。
   - デプロイだけでLINEリッチメニューを自動公開しません。

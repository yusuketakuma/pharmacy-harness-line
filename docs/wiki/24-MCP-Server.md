# 24. MCP Server

LINE Harness MCP Server は [Model Context Protocol](https://modelcontextprotocol.io/) に準拠したサーバー。Claude Code や他の MCP クライアントから LINE 公式アカウントを自然言語で操作できる。

---

## セットアップ

### npx (推奨)

```json
// .mcp.json
{
  "mcpServers": {
    "line-harness": {
      "command": "npx",
      "args": ["-y", "@line-harness/mcp-server@latest"],
      "env": {
        "LINE_HARNESS_API_URL": "https://your-worker.workers.dev",
        "LINE_HARNESS_API_KEY": "your-api-key",
        "LINE_HARNESS_ACCOUNT_ID": "your-line-account-id"
      }
    }
  }
}
```

`LINE_HARNESS_ACCOUNT_ID` はリッチメニュー操作の必須固定スコープです。未設定・別アカウント指定は実行前に拒否されます。

### Codex

同じ設定をプロジェクトの MCP 設定へ登録します。

```toml
[mcp_servers.line-harness]
command = "npx"
args = ["-y", "@line-harness/mcp-server@latest"]

[mcp_servers.line-harness.env]
LINE_HARNESS_API_URL = "https://your-worker.workers.dev"
LINE_HARNESS_API_KEY = "your-api-key"
LINE_HARNESS_ACCOUNT_ID = "your-line-account-id"
```

### ローカルビルド

```bash
cd packages/mcp-server
pnpm install
pnpm build

# 実行
LINE_HARNESS_API_URL=https://your-worker.workers.dev \
LINE_HARNESS_API_KEY=your-api-key \
LINE_HARNESS_ACCOUNT_ID=your-line-account-id \
node dist/index.js
```

---

## ツール一覧

### 読み取り系

| ツール | 説明 |
|--------|------|
| `list_friends` | 友だち一覧（名前検索・タグ・メタデータフィルタ） |
| `get_friend_detail` | 友だち詳細 |
| `get_form_submissions` | フォーム回答取得 |
| `get_link_clicks` | リンククリック分析 |
| `get_conversion_logs` | コンバージョンログ |
| `account_summary` | アカウント概要 |
| `list_crm_objects` | CRMオブジェクト汎用一覧 |

### 書き込み系

| ツール | 説明 |
|--------|------|
| `send_message` | テキスト・画像・Flex送信 |
| `broadcast` | 一斉配信 |
| `create_scenario` | シナリオ作成 |
| `enroll_in_scenario` | シナリオ登録 |
| `create_form` | フォーム作成 |
| `create_rich_menu` | リッチメニュー作成（画像対応） |
| `create_tracked_link` | トラッキングリンク作成 |
| `upload_image` | 画像アップロード |

### 管理系

| ツール | 説明 |
|--------|------|
| `manage_friends` | 友だち管理（count, metadata, richMenu） |
| `manage_tags` | タグCRUD + 友だちへの付け外し |
| `manage_scenarios` | シナリオ管理（CRUD + ステップCRUD） |
| `manage_broadcasts` | 配信管理（CRUD + セグメント配信） |
| `manage_rich_menus` | リッチメニュー管理（list, delete, default） |
| `manage_pharmacy_rich_menus` | 薬局メニューの下書き準備、画像保存、確認、公開、取り下げ、友だち適用 |
| `manage_forms` | フォーム管理（CRUD） |
| `manage_tracked_links` | トラッキングリンク管理（list, delete） |
| `manage_staff` | スタッフ管理 |
| `manage_ad_platforms` | 広告プラットフォーム管理 |

### Resources (MCP Resources)

| URI | 説明 |
|-----|------|
| `line-harness://friends` | 友だち一覧 (最新20件) |
| `line-harness://scenarios` | シナリオ一覧 |
| `line-harness://tags` | タグ一覧 |

---

## URL自動追跡

v0.4.0 より、`send_message` と `broadcast` で送信するメッセージ中の URL は自動的にトラッキングリンクに変換される。

### 動作

1. メッセージ中の URL を検出
2. トラッキングリンクを自動生成
3. テキストメッセージは Flex メッセージ（ボタン付き）に自動変換
4. LINE アプリ内クリック → LIFF 経由でユーザー特定
5. PC ブラウザクリック → 直接リダイレクト（クリック数のみ記録）

### スキップされる URL

- 既存のトラッキングリンク (`/t/{uuid}`)
- LIFF URL (`liff.line.me`)
- LINE ディープリンク (`line.me/R/`)
- Worker 内部 URL

---

## 使用例

### Claude Code での操作例

```
> 友だち数を教えて

→ account_summary ツールが呼ばれ、友だち数・タグ・シナリオの概要を表示

> VIPタグのついた友だちに「キャンペーン開始！ https://example.com 」と配信して

→ broadcast ツールが呼ばれ、VIPタグで絞り込み配信
→ URL は自動的にトラッキングリンク + Flex ボタンに変換

> さっきの配信のクリック数を見せて

→ get_link_clicks ツールで誰がクリックしたか確認

### 薬局リッチメニューの安全な操作

初期メニューは `prepare` で一度だけ作成されます。LINEへ公開する操作は、必ず dry-run の結果を確認してから `dryRun=false` と `confirm=true` を指定します。

```
> 薬局の初期リッチメニューを準備して
→ manage_pharmacy_rich_menus(action="prepare")

> group-1 の公開内容を確認して
→ manage_pharmacy_rich_menus(action="publish", groupId="group-1", dryRun=true)

> 確認結果どおり公開して
→ manage_pharmacy_rich_menus(action="publish", groupId="group-1", dryRun=false, confirm=true)

> group-1 の page-2 に画像を保存して
→ manage_pharmacy_rich_menus(action="save_image", groupId="group-1", pageId="page-2", imageData="...base64...", imageContentType="image/jpeg", dryRun=true)
→ 内容を確認後、同じ操作を dryRun=false, confirm=true で実行

> group-1 の area-1 を page-2 への切替にして
→ manage_pharmacy_rich_menus(action="set_switch", groupId="group-1", sourcePageId="page-1", areaId="area-1", targetPageId="page-2", dryRun=true)
→ 内容を確認後、同じ操作を dryRun=false, confirm=true で実行
```

初期画像は `apps/worker/public/custom/pharmacy/rich-menu/initial-compact-3x1.jpg` に同梱されます。gpt-image-2で生成した画像をLINE規定の2500×843へ整形し、準備APIがD1下書きとR2画像を冪等に作成します。`save_image` は同じアカウントスコープ付きSDK経路で、ページ画像をR2へ保存してD1のページに紐付けます。

画面切替は、Lステップ系の運用で一般的な「複数メニューをタブとして持つ」構成に合わせています。管理画面でページを追加し、切替元のエリアを `タブ切替 (richmenuswitch)` にして遷移先ページを指定します。公開時にページIDをLINE aliasへ解決するため、LINE上のメニューIDを直接保存する必要はありません。公開前はプレビュー、公開後は再登録が必要です。

---

## アーキテクチャ

```
Claude Code / MCP Client
    ↓ (stdio)
MCP Server (@line-harness/mcp-server)
    ↓ (HTTP)
@line-harness/sdk
    ↓ (HTTP + API Key)
CF Workers API
    ↓
D1 Database + LINE Messaging API
```

MCP Server は SDK のラッパー。SDK の全機能を MCP ツールとして公開している。

---

## 開発

```bash
cd packages/mcp-server

# ビルド
pnpm build

# ウォッチモード
pnpm dev

# 依存パッケージ
# - @line-harness/sdk (workspace)
# - @modelcontextprotocol/sdk
# - zod
```

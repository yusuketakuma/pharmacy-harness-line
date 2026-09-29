---
type: architecture
title: 共有パッケージ
description: packages/ 配下の db・shared・line-sdk・sdk・mcp-server・update-engine・create-line-harness・plugin-template それぞれの責務、アプリからの依存関係、薬局フォークでの扱い。
tags: [packages, monorepo, line-sdk, mcp, update-engine, db]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-99de51df25f29bfc72caf823
    resource: repo://apps/web/package.json
  - id: openwiki-source-300ef720cd83b06e362ce584
    resource: repo://apps/worker/package.json
  - id: openwiki-source-8015fc133daf28facc23cdb3
    resource: repo://packages/AGENTS.md
  - id: openwiki-source-8596309d60654cb0a2558573
    resource: repo://packages/line-sdk/src/client.ts
  - id: openwiki-source-35ac8c9a6fc2c825c488ce71
    resource: repo://packages/mcp-server/src/index.ts
  - id: openwiki-source-a0de16dc7b4682d4aa38f7ac
    resource: repo://packages/update-engine/src/index.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# 共有パッケージ

`packages/*` は pnpm ワークスペースの共有コードです(方針の要約は `packages/AGENTS.md`)。Worker が直接依存するのは `@line-crm/db`・`@line-crm/line-sdk`・`@line-crm/shared`、管理画面(`apps/web`)が依存するのは `@line-crm/shared` です。それ以外は外部向け・運用向けの道具で、アプリの実行時には使われません。

| パッケージ | 役割 | 誰が使うか |
| --- | --- | --- |
| `db` (`@line-crm/db`) | D1 のクエリヘルパー、`schema.sql`、`migrations/`、`bootstrap.sql` | Worker |
| `shared` (`@line-crm/shared`) | 型と定数(`types.ts`・`sticker.ts`) | Worker・Web |
| `line-sdk` (`@line-crm/line-sdk`) | LINE Messaging API の薄いラッパー(`LineClient`、メッセージビルダー、webhook 署名検証) | Worker |
| `sdk` (`@line-harness/sdk`) | 外部向け TypeScript SDK(HTTP クライアントと `resources/`) | 外部利用者 |
| `mcp-server` (`@line-harness/mcp-server`) | AI エージェントが操作する MCP サーバー(stdio) | エージェント |
| `update-engine` | 自己更新エンジン(preflight → apply → verify、失敗時 rollback) | Worker と CLI |
| `create-line-harness` | セットアップ/更新 CLI(`commands/setup.ts`・`update.ts`) | 導入者 |
| `plugin-template` | 外部連携プラグインの雛形 | 開発者 |

## db

<!-- openwiki: broken internal link [/openwiki/concepts/database-and-migrations.md] link "/openwiki/concepts/database-and-migrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
スキーマは `schema.sql` と `migrations/` にあり、薬局向けの追加は `custom_NNN` の追記のみです。詳細は [データベースと migration](/openwiki/concepts/database-and-migrations.md) に書きました。`packages/AGENTS.md` は「`line_account_id` / `tenant_id` で絞らないクエリを `db` に足さない」「PHI を含む列は暗号化方針に従う」をルールにしています。

## line-sdk

<!-- openwiki: broken internal link [/openwiki/workflows/line-webhook-and-outbound-delivery.md] link "/openwiki/workflows/line-webhook-and-outbound-delivery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`LineClient` は LINE API へ Bearer で `fetch` するだけの薄い層です。`X-Line-Retry-Key` 付きのリクエストが `409` を返した場合は「同じ操作が既に受理済み」とみなして成功(`retryAccepted: true`)を返し、再送しても二重配信の失敗にならないようにしています。それ以外のエラーは `createLineApiError` で例外にします。`packages/AGENTS.md` により、エラーメッセージに上流のレスポンス本文を含めない方針です。Worker はこの `LineClient` で push・broadcast・リッチメニュー操作を行います(→ [LINE webhook と送信配信](/openwiki/workflows/line-webhook-and-outbound-delivery.md))。

## mcp-server

`src/index.ts` が `McpServer`(名前 `line-harness`)を作り、`registerAllTools` と `registerAllResources` を登録して stdio で待ち受けます。汎用ツールは `src/tools/`、薬局固有の操作は `src/custom/pharmacy/`(現状はリッチメニュー)に置きます。

## update-engine

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`runUpdate` が更新の入口です。バンドルを検証し、`preflight`(読取りのみの検査)→ `apply`(破壊的)→ `verify` の順に実行し、失敗したら `rollback` を走らせます。スナップショットとイベントは D1 に保存され、進捗は SSE などへ流せます。Cloudflare API(Workers・Pages・D1)の呼出しは `cf-api/` にまとまっています。これはフォーク元由来の仕組みです。薬局フォークでは、本番更新は別途の明示承認と後方互換の要件を満たす必要があります(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。

## create-line-harness と plugin-template

<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`create-line-harness` は汎用の初期セットアップ CLI で、薬局テナントの作成には使わず `scripts/custom/pharmacy` を使います(→ [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md))。`plugin-template` は Worker とは別デプロイのプラグイン雛形(`wrangler.toml`・`notify.ts`・`sync.ts`)です。

## バージョン

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`sdk` と `mcp-server` は 0.36.4 で、Worker の版と揃っています。`db`・`shared`・`line-sdk` は 0.2.0 の別系列です。パッケージ版と薬局のリリース版は別の識別子として扱います(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。

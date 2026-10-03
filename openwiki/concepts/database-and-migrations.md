---
type: concept
title: データベースと migration
description: packages/db のスキーマ・migration の番号体系(baseline と custom_NNN)、bootstrap.sql の生成、クエリヘルパー、テスト用 SQLite アダプタ、追加のみの更新方針を説明する。
tags: [database, d1, migrations, sqlite, schema, backward-compatibility]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-0fb57a8a6236aa9ba37f6f3e
    resource: repo://apps/worker/src/custom/pharmacy/test-sqlite.ts
  - id: openwiki-source-f1a0161d06a62851ac6e7c88
    resource: repo://packages/db/bootstrap-meta.json
  - id: openwiki-source-44019a96a66574dcb58cfd2e
    resource: repo://packages/db/migrations/025_friend_link_scope_triggers.sql
  - id: openwiki-source-b5880709a9de8be2245a1364
    resource: repo://packages/db/migrations/029_custom_081_pharmacy_validity_notification_queue.sql
  - id: openwiki-source-4a2a13cfbeb1c347b903e573
    resource: repo://packages/db/scripts/generate-bootstrap.mjs
  - id: openwiki-source-c0440451c0e72cc74fbbef14
    resource: repo://packages/db/test/bootstrap-generator.test.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# データベースと migration

データストアは Cloudflare D1(SQLite)です。スキーマとクエリヘルパーは `packages/db`、薬局固有のクエリは各ドメインの `repository.ts`(`apps/worker/src/custom/pharmacy/<domain>/`)にあります。

## packages/db の構成

| 場所 | 内容 |
| --- | --- |
| `migrations/` | 連番の SQL(現在 29 本) |
| `schema.sql` | 完成形のスキーマ(`db:migrate` スクリプトが参照) |
| `bootstrap.sql` / `bootstrap-meta.json` | 全 migration を束ねた初期化 SQL とそのメタ情報(生成物) |
| `scripts/generate-bootstrap.mjs` | `bootstrap.sql` の生成器 |
| `src/*.ts` | generic 機能のクエリヘルパー(`friends`・`broadcasts`・`line-accounts` など)。`src/index.ts` が再 export |
| `test/` | migration ごとの検証テストとヘルパーのテスト |

## migration の番号体系

ファイル名は `NNN_[custom_MMM_]name.sql` の形式で、`generate-bootstrap.mjs` が正規表現で検証します。`NNN` は全体で 1 つの通し番号(`001` が baseline、`002` 以降が追加分)です。薬局固有の変更は `custom_MMM`(現在 `custom_060`〜`custom_081`)を名前に含めます。例えば `029_custom_081_pharmacy_validity_notification_queue.sql` は処方箋有効期限の通知キュー用に列とインデックスを足すだけです。

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
baseline は `001_v033_baseline.sql` で、メタ情報上の状態は `mutable-prerelease`、スキーマの世代は `v0.33`、モードは `pharmacy-multitenant` です。baseline より後の migration は追加のみとし、既存ファイルを書き換えません(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

## bootstrap の生成

`generate-bootstrap.mjs` は baseline と、それ以降の migration をファイル名順に一時的な SQLite へ適用し、`bootstrap.sql` と `bootstrap-meta.json`(`migrationCount`・含まれる migration 一覧)を出力します。`duplicate column name` や `already exists` といった良性のエラーは許容し、それ以外は失敗にします。これにより新規環境は 1 ファイルで初期化でき、既存環境は差分の migration だけを適用できます。`test/bootstrap-generator.test.ts` は、生成結果が commit 済みの `bootstrap.sql` と一致することと、複数行のトリガー本体・`CASE`・コメント・引用符内のセミコロンが正しく分割されることを検証します。

## 追加のみ・後方互換の書き方

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
migration は「新しい列を NULL 可または DEFAULT 付きで足す」「新しいテーブルとインデックスを足す」形が中心です。制約は `CHECK` で表現します(例: 日時列は `unixepoch(...) IS NOT NULL`)。通知キュー用の部分インデックス(`WHERE ... reminder_sent_at IS NULL`)のように、処理対象だけを引く索引を使う例があります(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。列やテーブルの削除・改名は行いません。旧版の Worker が新しいスキーマでも動き続け、ロールバックできることが要件です。

## テナント境界

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`packages/AGENTS.md` は「`line_account_id`/`tenant_id` で絞らないクエリを `db` に足さない」を規則にしています。`004_custom_061_generic_resource_tenant_scope`、`005_custom_062_ref_tracking_tenant_scope`、`025_friend_link_scope_triggers` のように、generic な資源にテナントの範囲をスキーマ側(列・トリガー)でも課す migration があります(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。認証まわりの `006`〜`014` は、セッション失効・ローテーション・ログイン試行制限・患者代理操作の制御・監査を追加しています。

## テスト用アダプタ

<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Worker のテストは `apps/worker/src/custom/pharmacy/test-sqlite.ts` を使います。`better-sqlite3` はインメモリの SQLite で、`bootstrap.sql`/`schema.sql` を適用してから最小限の `D1Database` 互換アダプタで包みます。`batch()` は実トランザクションで実行し、途中で失敗すると全体をロールバックして D1 の原子的バッチと同じ挙動にします(→ [テストと検証](/openwiki/operations/testing-and-verification.md))。

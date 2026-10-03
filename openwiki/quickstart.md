---
type: quickstart
title: クイックスタート
description: 薬局向け LINE 運用基盤リポジトリの全体像、最初に守る規則、開発・検証コマンド、やりたいこと別にどの OpenWiki ページを読めばよいかの案内。
tags: [quickstart, overview, navigation, pharmacy, cloudflare]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# クイックスタート

## このリポジトリは何か

OSS の LINE Harness(LINE 公式アカウント向け CRM)を、**薬局向けにフォークしたもの**です。患者は LINE と LIFF で処方箋の事前送信・問診・服薬フォローなどを使い、薬局スタッフは管理画面と LINE の 1 対 1 チャットで対応します。実行環境は Cloudflare(Worker + D1 + R2 + Pages)で、pnpm のモノレポです。

| 場所 | 役割 |
| --- | --- |
| `apps/worker` | Worker(Hono)。API、LINE webhook、cron |
| `apps/web` | スタッフ向け管理画面(Next.js を静的出力) |
| `apps/liff` | 患者向け LIFF アプリ(Vite + React) |
| `packages/*` | 共有コード(`db`・`shared`・`line-sdk`・`sdk`・`mcp-server` ほか) |
| `scripts/custom/pharmacy` | テナント作成などの運用スクリプト |
| `docs/pharmacy` | 契約・運用・監査の正本文書(入口は `docs/README.md`) |
| `CHANGELOG.md` / `PLANS.md` | リリース履歴 / タスク台帳 |

コードの薬局向け追加は `custom/pharmacy` の下に閉じ込め、DB は `custom_NNN` の追加 migration だけで変えます。

## 最初に守る規則

1. **`line_account_id` とサーバー側のスタッフ認可で絞る。** クエリパラメータは選択子であって権限ではありません。
2. **自動通知は PHI を含まない、承認済みテンプレートだけ。**
3. **非破壊・後方互換で更新する。** スキーマの drop/rename、API の削除・改名、Worker/Admin/LIFF の同時切替に依存する変更はしません。
4. **本番の変更・配備は、明示的な承認と証跡が必要。** ローカルのテスト成功は、リリースや本番運用の完了を意味しません。
5. LINE Harness Proxy から担当者として 1 対 1 返信するときは `X-Line-Harness-Source: manual` を付けます(自動送信には付けません)。

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
詳しくは [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md) にあります。

## 開発と検証のコマンド

| 目的 | コマンド |
| --- | --- |
| Worker / 管理画面を起動 | `pnpm dev:worker` / `pnpm dev:web` |
| CI と同じ検証(整形・ビルド・型検査・テスト・migration 検査) | `pnpm verify:ci` |
| スクリプトのテストだけ | `pnpm test:scripts` |
| 整形と lint(Biome) | `pnpm format:check` / `pnpm lint` |
| テナント作成などの運用 CLI | `pnpm tenant:setup` ほか(本番を変更する操作は承認が必要) |

<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
変更の影響に合わせて範囲を選びます。詳細は [テストと検証](/openwiki/operations/testing-and-verification.md) を参照してください。

## やりたいこと別の入口

| やりたいこと | 読むページ |
| --- | --- |
<!-- openwiki: broken internal link [/openwiki/architecture/system-overview.md] link "/openwiki/architecture/system-overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 全体像・実行環境・generic と薬局の関係を知る | [システム全体構成](/openwiki/architecture/system-overview.md) |
<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| API の共通処理(middleware の順序、静的配信、cron)を知る | [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md) |
<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 患者向け・スタッフ向け画面の構成を知る | [フロントエンド(LIFF と管理画面)](/openwiki/architecture/frontends-liff-and-admin.md) |
<!-- openwiki: broken internal link [/openwiki/architecture/shared-packages.md] link "/openwiki/architecture/shared-packages.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| `packages/` の役割を知る | [共有パッケージ](/openwiki/architecture/shared-packages.md) |
<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 認証・セッション・テナント越境の防ぎ方を知る | [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md) |
<!-- openwiki: broken internal link [/openwiki/concepts/database-and-migrations.md] link "/openwiki/concepts/database-and-migrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 新しい列やテーブルを追加する | [データベースと migration](/openwiki/concepts/database-and-migrations.md) |
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| PHI の暗号化・ログ・保持・削除を知る | [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md) |
<!-- openwiki: broken internal link [/openwiki/workflows/line-webhook-and-outbound-delivery.md] link "/openwiki/workflows/line-webhook-and-outbound-delivery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| LINE の受信・送信、Proxy、再試行を知る | [LINE webhook と送信配信](/openwiki/workflows/line-webhook-and-outbound-delivery.md) |
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-patient-journeys.md] link "/openwiki/workflows/pharmacy-patient-journeys.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 患者の処方箋・問診・服薬フォロー・継続・EC の流れを知る | [薬局の患者導線](/openwiki/workflows/pharmacy-patient-journeys.md) |
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 自動通知を追加・変更する | [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md) |
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 機能の有効化、リッチメニュー、ベータ参加を知る | [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md) |
<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| 新しい薬局(テナント)を作る | [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md) |
<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| リリース・配備の流れと確認項目を知る | [リリースとデプロイ](/openwiki/operations/release-and-deploy.md) |

## 使い方の注意

この OpenWiki は概要把握の補助です。正本は常にリポジトリのコードと `docs/pharmacy/` の文書で、重要な判断の前には実コードで確認してください。ページには「実装済み」と「本番で実施済み」を区別して書いてあります。本番の secret 投入・backfill・削除・配備などは、文書上いずれも未実施(`NOT_RUN`)として扱われています。

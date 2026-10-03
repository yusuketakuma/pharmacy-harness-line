---
type: concept
title: 薬局 custom 境界と非破壊更新ルール
description: フォーク元の generic 機能と薬局固有機能を分ける custom/pharmacy seam、薬局モードの判定と fail-closed の考え方、機能(capability)の仕組み、非破壊・後方互換で更新するというプロジェクトルールを説明する。
tags: [pharmacy, custom-seam, capability, fail-closed, backward-compatibility, governance]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-58029d197f8e0e694e248301
    resource: repo://apps/worker/src/custom/pharmacy/account.ts
  - id: openwiki-source-003a2664da71e11b665cb6ed
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/access.ts
  - id: openwiki-source-9a19f47c57e4460a65da6271
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# 薬局 custom 境界と非破壊更新ルール

このフォークの最重要の設計判断は「フォーク元(generic な LINE CRM)を壊さず、薬局向けの追加を決まった場所に閉じ込める」ことと「薬局アカウントでは危険な generic 機能を確実に止める」ことです。`CLAUDE.md` がこの規則の正本です。

## seam(継ぎ目)の場所

| 種類 | 置き場所 |
| --- | --- |
| Worker の薬局実装 | `apps/worker/src/custom/pharmacy/<domain>/` |
| DB の追加 | `packages/db/migrations/NNN_custom_MMM_*.sql`(追記のみ) |
| LIFF / 管理画面 | `apps/liff/src/custom/pharmacy/`、`apps/web/src/custom/pharmacy/` |
| 運用スクリプト | `scripts/custom/pharmacy/` |
| MCP | `packages/mcp-server/src/custom/pharmacy/` |

`index.ts` などフォーク元と共有するファイルに薬局の記述を入れるときは、`// custom:pharmacy-...` のコメントで印を付けます。禁止事項として、AI/OCR、マーケットプレイスへの経路、処方箋・継続ドメインの二重モデルを足さないことが `CLAUDE.md` に明記されています。

## 薬局モードの判定

薬局モードかどうかは、アカウントごとの `pharmacy_account_capabilities` 行の `mode = 'pharmacy'` で決まります(`growth-loop/access.ts`)。テナントの紐付けだけでは判定しません。generic な CRM のテナントも通常のスコープのために紐付くことがあるからです。

判定関数(`isPharmacyModeAccount`・`isPharmacyTenant`・`hasPharmacyModeAccount`)は共通して **fail-closed** です。

- DB の読取りで例外が起きたら「薬局モードである」と答え、generic な配信経路を再び開けません。
- `pharmacy_account_capabilities` テーブルがデプロイ済みなのに該当行が無い場合も薬局扱いにします。これは、テーブルの有無をメタデータ(`sqlite_master`)で確認する `pharmacyCapabilityTableDeployed` で判断します。テーブルがまだ無い旧環境は従来どおり generic として動きます。

`hasPharmacyCapability` はその逆で、例外時は `false`(機能を許可しない)です。

## capability(機能の許可)

<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
機能は 2 種類あります。患者向けは `prescription_intake`・`patient_intake`・`electronic_prescription`・`continuity`・`medication_followup`・`emergency_contraception`・`meet_consultation`・`manual_chat`・`pharmacy_info`、管理向けは `fulfillment_quote`・`pharmacy_rich_menu`・`account_settings`・`pharmacy_dashboard` です。既定では `electronic_prescription` 以外が有効です。JSON 列 `capabilities_json` は読取り時に既知の値だけに絞り込まれます。LIFF の機能ゲートはこのサーバー値を表示に使うだけで、最終判断はサーバーです(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md)、[Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))。

## generic API の遮断(3 段)

1. `pharmacyTenantApiAllowlistGuard`: 薬局テナントは、許可リスト(`/api/custom/pharmacy`・`/api/liff/pharmacy`・`/api/auth`・`/api/chats`・`/api/friends` の一部・`/api/tags` など)以外の `/api/*` が 403 `Feature disabled for pharmacy tenant` になります。画像は POST のみ、取得は読取り系メソッドのみです。platform admin は、管理 API のカバレッジ表に載っているパスだけ通します。
2. `pharmacyGenericFeatureGuard`: broadcasts・scenarios・automations・auto-replies・reminders・mileage・affiliates・forms・booking などの高リスクな generic API を、薬局アカウントでは止めます。
3. `pharmacyManualChatMutationGuard`: 手動チャットの書込みを別枠で制御します。

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
cron 側は、1 つでも薬局アカウントがあれば generic cron 全体を止めます(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。

## スコープと認可の原則

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
すべての薬局のクエリと変更は `line_account_id` とサーバー側のスタッフ認可で絞ります。クエリパラメータは選択子であって権限ではありません。`pharmacyAccountGuard`(`account.ts`)は `line_account_id`(または `accountId`)を必須とし、`resolveAccessiblePharmacyTenant` が 1 つの SQL で「アカウントとテナントの対応・テナントが有効・スタッフのメンバーシップ・アカウントへの割当」を同時に検証します。分けて検査すると、読取りの間に割当が変わる隙を作るためです。結果のテナントが認証済みテナントと一致しなければ 403 です。詳細は [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md) にあります。

## 通知とデータの原則

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
自動通知は PHI を含まない、承認済みテンプレートだけです(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。PHI を含む列の暗号化と保持は [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md) に従います。

## 非破壊・後方互換の更新ルール

`CLAUDE.md` は今後の更新すべてに次を課します。

- 本番ストレージを更新手段としてリセット・再作成しない。スキーマの drop・rename をしない。
- 既存の API フィールドやルートを削除・改名しない。意味を非互換に変えない。
- Worker / Admin / LIFF の同時(ロックステップ)配備を要求しない。
- 追加スキーマ、expand / dual-read / dual-write / default / fallback のパターンを使い、旧版の契約を配備とロールバックの間ずっと動かし続ける。
- 契約を変える場合は、旧版との互換性を確かめる焦点テストが無ければリリースできない。

LIFF の `isUnsupportedPharmacyFeature`(旧 Worker の 401/404 を未対応機能として扱う)や、`pharmacySharedStaffSchemaDeployed`(共有スタッフ用の列がまだ無いスキーマでは旧の割当経路にフォールバックする)は、この規則が実コードに現れた例です。

## 主張の区別

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
OSS のパッケージ版と `pharmacy-v*` の販売者向けリリース版は別の識別子で、片方から他方を推測しません。ローカルのコード・テスト成功・リリースメタデータ・デプロイ証跡・本番運用は、それぞれ別の主張です。本番の変更やデプロイには、明示的な承認・人による確認・実行の証跡が必要です(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。

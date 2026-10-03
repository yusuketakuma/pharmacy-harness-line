---
type: workflow
title: Growth Loop・リッチメニュー・ベータ参加
description: 薬局の機能有効化(capability)と Growth Loop の設定・当日の対応キュー・KPI、リッチメニューの版管理と公開前確認、ベータ参加(membership)による患者操作の制御と送信時の再確認を説明する。
tags: [growth-loop, rich-menu, beta-membership, capability, kpi, action-queue]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-467290a325a70ca42b462f98
    resource: repo://apps/worker/src/custom/pharmacy/beta-membership/repository.ts
  - id: openwiki-source-b5642783a1907f753f83e328
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/action-queue.ts
  - id: openwiki-source-e9aa7dd3f4448293f6061a1e
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/operations-summary.ts
  - id: openwiki-source-e97c19e28c4a80f8a06d2478
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/patient-feature-access.ts
  - id: openwiki-source-ba632d0152c18e2b25549110
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/policy.ts
  - id: openwiki-source-3fd6d426e055e27da2792bbe
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/sender.ts
  - id: openwiki-source-8100b8cb381b4bb9fadcf163
    resource: repo://apps/worker/src/custom/pharmacy/rich-menu/catalog.ts
  - id: openwiki-source-af586a889270328654f88ed2
    resource: repo://apps/worker/src/custom/pharmacy/rich-menu/publish-confirmation.ts
  - id: openwiki-source-4374e09ffb5707510e0f6838
    resource: repo://apps/worker/src/custom/pharmacy/rich-menu/publish-readiness.ts
  - id: openwiki-source-0743d7a1ad0ef4e12ad47ca9
    resource: repo://apps/worker/src/custom/pharmacy/rich-menu/routes.ts
  - id: openwiki-source-283c1e41540d095878692883
    resource: repo://docs/pharmacy/BETA_PARTICIPATION.md
  - id: openwiki-source-b39d2ba4f046ad36dce8a482
    resource: repo://docs/pharmacy/GROWTH_KPI_DEFINITIONS.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# Growth Loop・リッチメニュー・ベータ参加

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
この 3 つは、「どの薬局のどの患者に、どの機能を見せ、どの通知を送ってよいか」を決める層です。いずれも `line_account_id` とサーバー側の認可で絞り、クエリやボディの ID は選択子として扱います(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

## 患者が使える機能は 5 段の権限の積

`docs/pharmacy/BETA_PARTICIPATION.md` は、次の 5 つが互いに代替できない別の権限だと定めます。すべてサーバーで評価します。

| 層 | 意味 | それだけでは証明できないもの |
| --- | --- | --- |
| LINE の本人性 | ID トークンの `aud`(`liffId`)から、ちょうど 1 つのアカウントと友だちが決まる | ベータ参加・同意・代理権限 |
| 患者/代理の権限 | 所有する友だち、患者リンク、アーカイブ、紐付け停止、未成年代理の期限 | ベータ参加 |
| 同意・プライバシー状態 | 代表者・プライバシー同意の版、制御版の CAS | ベータ参加 |
| アカウントの capability | `pharmacy_account_capabilities` の機能フラグ | 上記のすべて |
| ベータ参加 | `pharmacy_beta_memberships` の行(サーバー時刻で `[starts_at, expires_at)` に `active`) | 上記のすべて |

## capability と Growth Loop 設定

<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
機能の許可一覧、月あたりの能動通知の上限(`proactive_monthly_limit`)、配信解除(unfollow)の扱い(`alert_only` か `auto_pause`)は、アカウントごとの設定行にあり、`GET/PUT /api/custom/pharmacy/growth/config` で読み書きします(`growth-loop/routes.ts`)。更新は `revision` を持ち、リッチメニューなど他機能はこの版が古くなったことを検出します。LIFF が機能の一覧を得る経路は 2 つで、認証なしの `/api/liff/config`(有効な capability)と、認証付きの `/api/liff/pharmacy/feature-access`(その患者が過去に使った「既存機能」の一覧。`patient-feature-access.ts` が各ドメインの表に `EXISTS` を引くだけで、記録の内容は返しません)です(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md))。

### 対応キューと運用サマリー

- **対応キュー**(`action-queue.ts`): 処方箋受付・電子処方箋・問診・継続・服薬フォロー・EC・手動チャットの各ドメインについて、期限が近い・過ぎた項目を最大 50 件まで返します。項目は、ドメイン、状態、期限の区分(`overdue`・`today`・`upcoming`・`none`)、詳細画面へのリンクだけで、患者の識別子や内容は含めません。ドメインごとの SQL は、追加列がまだ配備されていない環境では代替 SQL に落として一覧から外しません。取得が一部失敗した場合は `partial`、上限を超えた場合は `truncated` を立てて、欠けていることを隠しません。
<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **運用サマリー**(`operations-summary.ts`): 同じドメインについて、状態別の件数と最終更新を返します。`readiness`(→ [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md))と組み合わせて、管理画面の「本日の対応」に使われます。
- **KPI ダッシュボード**: `GET /api/custom/pharmacy/growth/dashboard` の指標は `docs/pharmacy/GROWTH_KPI_DEFINITIONS.md` が正本です。期間は JST の月境界で、成熟していないコホートは率の分母から除き「未成熟」と併記します。初回・2 回目の送信率、受付元(`primary`/`other`/`unknown`)の分類率、準備完了の約束(予定内率・遅延の中央値と 90 パーセンタイル)、処方箋の使用期限の確認・通知・期限内完了などを、患者識別子なしで集計します。受付元の付与(`.../submissions/:id/source`)と使用期限の確認(`.../validity`)は、その入力を受ける管理 API です。

### 自動通知の制約

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
自動通知は、承認済みの固定テンプレート `PharmacyAutomatedMessageId`(処方箋状況・継続案内・使用期限・服薬フォロー・予約・マイナ引継ぎ・EC 受付状況・Meet 相談など)だけで、`policy.ts` の `buildApprovedPharmacyMessage` が構築します。文面は「詳しくは LINE アプリで」のように中立で、EC は語そのものを出しません。変数は列挙値・日付・ID に限って検証し、本文は 500 文字以内で、未知の ID や不正な変数は例外です。送信は `sender.ts` の経路で、カテゴリ(`transactional_care`・`followup_care`・`continuity`・`proactive_noncare`)と結果(`sent`・`already_sent`・`in_progress`・`reconciliation_required`・`patient_blocked`・`operations_blocked`・`paused`)を持ちます(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。

## リッチメニュー

薬局のリッチメニューは、汎用のリッチメニュー機能とは別に、`custom/pharmacy/rich-menu/` が版管理と公開前確認を持ちます。管理 API は `/api/custom/pharmacy/rich-menus/*` で、platform admin は拒否し(403)、テナントのスタッフだけが使えます。

- **レイアウトと variant**: 既定の並びは `prescription-send`・`prescription-history`・`medication-followup`・`manual-chat`・`pharmacy-info` の 5 つで、アカウントの capability で有効な操作だけに絞った「実効の並び」から `variantKey` を導きます。ボタン数は 1〜3 個が compact(高さ 843)、4〜6 個が large(高さ 1686)のレイアウトです。
<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **画像カタログ**: 事前生成した画像を R2 の `rich-menu-catalog/<版>/manifest.json` に置き、カタログ版(現在 `v4-5`)は、ちょうど 228 の variant を含むことを検証します(各画像は 2500 幅の JPEG、SHA-256 を持つ)。画像の生成は `pnpm rich-menu:catalog`、変更があった場合の公開は配備ワークフローが担います(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。
- **公開前確認**(`publish-readiness.ts`): 下書き版を公開する前に、版の紐付け、アカウント一致、下書き状態、メニューサイズ、レイアウトの revision、capability の revision、LIFF 設定のハッシュ、カタログ版のすべてが、下書きを作った時点と一致していることを確かめます。1 つでも古ければ `BLOCKED` と理由コード(`LAYOUT_REVISION_STALE` など)を返し、確認できた場合だけ証跡ダイジェストを返します。
- **公開の確認トークン**(`publish-confirmation.ts`): 公開はこの証跡ダイジェストに紐づく HMAC 署名付きの確認(有効 5 分、テナント・アカウント・版に束縛)を必須とし、中断した公開は段階(意図記録 → リモート作成 → 画像アップロード → alias 作成)から再開できます。
- 公開後の既定設定の読み戻しが未確認の間は、readiness が `RICH_MENU_DEFAULT_READBACK_UNVERIFIED` のように `UNVERIFIED` を返し、「公開済み」を主張しません。

## ベータ参加(membership)

`beta_enabled` は既定で 0 で、アカウントで有効にすると、患者の操作は `pharmacy_beta_memberships` の active な行(アカウント × 参加者 × 対象患者、CAS の `version`、種別 `self`/`family`)を必須とします。状態は `active`・`expired`(有効期限で自動)・`suspended`・`revoked` です。管理 API は `/api/custom/pharmacy/beta-memberships`(一覧・作成)と `:id/suspend|resume|revoke` で、各遷移は監査記録とセットで保存します。

- **判定**: `canUsePharmacyBetaParticipant` は、`beta_enabled` を読めなければ拒否、無効なら許可、有効なら active な membership がある場合だけ許可します。拒否は `403 Pharmacy beta participation required` で、ハンドラは実行されず記録も通知も生まれません。
- **例外**: 機能の発見(`feature-access`)は、非参加者には 403 ではなく空の一覧を返し、メニューだけ描画できるようにします。撤回・停止に当たる操作(代理の解除、同意の撤回、通知設定、アーカイブ)、データ主体請求、公開プロフィール・プライバシーポリシー、EC(独自の提供可否ゲートを持つ)は、参加を要求しません。LINE の受信メッセージは手動チャットとして受け付け、送信者をベータの臨床業務へ自動で登録することはありません。
- **送信時の再確認**: 通知キューは作成時に membership との紐付けを持ち、送信の直前に membership の世代を再確認します。`active` なら送信、`suspended` なら再試行可能な保留(失敗にしない)、`revoked` は再付与されても古いキューを復活させず、確認できなければ `operations_blocked` で fail-closed です。
- **スキーマの段階**: `getPharmacyBetaSchemaState` は追加スキーマの有無を `legacy`・`ready`・`unavailable` で判定し、部分適用や読取り不能を `legacy` とは扱いません(認可を弱めないため)。これも expand 型の後方互換の実例です。

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-patient-journeys.md] link "/openwiki/workflows/pharmacy-patient-journeys.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
関連: [薬局の患者導線](/openwiki/workflows/pharmacy-patient-journeys.md)、[テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md)。

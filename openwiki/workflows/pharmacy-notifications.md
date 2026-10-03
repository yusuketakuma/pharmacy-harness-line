---
type: workflow
title: 薬局の自動通知(PHI-free テンプレート)
description: 薬局の患者向け自動通知が、承認済みテンプレートと単一の送信関門 sendPharmacyAutomatedPush を通る仕組み、冪等・上限・停止・ベータ参加の再確認、各ドメイン(処方箋・継続・服薬フォロー・使用期限)のキュー処理、スタッフ向け activity 通知を説明する。
tags: [notifications, phi-free, templates, idempotency, queue, cron, activity-inbox]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-f182fb077e171de086e1d367
    resource: repo://apps/worker/src/custom/pharmacy/activity-notifications/repository.ts
  - id: openwiki-source-e2cbf8dac4c933c013eed0b8
    resource: repo://apps/worker/src/custom/pharmacy/activity-notifications/routes.ts
  - id: openwiki-source-2a3607d57aea197a082a6a45
    resource: repo://apps/worker/src/custom/pharmacy/continuity/notifications.ts
  - id: openwiki-source-ba632d0152c18e2b25549110
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/policy.ts
  - id: openwiki-source-3fd6d426e055e27da2792bbe
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/sender.ts
  - id: openwiki-source-a9f30625bdf5bd100dbd4678
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/validity.ts
  - id: openwiki-source-d2dfabe20f459d8a92a09c4d
    resource: repo://apps/worker/src/custom/pharmacy/medication-followup/notifications.ts
  - id: openwiki-source-080155e6db9d521a6e1abc32
    resource: repo://apps/worker/src/custom/pharmacy/prescriptions/notifications.ts
  - id: openwiki-source-fb9a7836d2cbbef8e7f5d5f5
    resource: repo://docs/pharmacy/PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# 薬局の自動通知(PHI-free テンプレート)

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
薬局の自動通知は、患者の LINE に届く**唯一の自動送信経路**です。generic な配信機能は薬局アカウントで遮断されている(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))ので、患者への自動送信はすべてこのページの経路を通ります。守るべき原則は 3 つです。

1. **PHI を含まない、承認済みの固定文面だけを送る。**
2. **同じ通知を二重に送らない。送ったか分からないときは盲目的に再送しない。**
3. **送信の直前に、患者・アカウント・テナントの最新状態を再確認する。**

## 承認済みテンプレート(`growth-loop/policy.ts`)

送れる文面は `PharmacyAutomatedMessageId` の固定リスト(`prescription_status_v1`・`continuity_reminder_v1`・`prescription_validity_reminder_v1`・`medication_followup_v1`・`appointment_reminder_v1`・`myna_handoff_status_v1`・`emergency_intake_status_v1`・`meet_consultation_v1`・`pharmacy_onboarding_v1`)だけです。

- 文面は `buildApprovedPharmacyMessage` が ID と変数から組み立てます。変数は、状態の列挙値、理由コード、日付・時刻、`liffId`、`submissionId`、`followUpId` など限られたものだけで、範囲外は例外です。本文は 500 文字以内で、未知の ID は拒否されます。
- 文面は意図的に中立です。EC(緊急避妊)は語を出さず「ご相談の受付状況」とし、電子処方箋も「手続き」と書きます。詳細は「LINE アプリで確認」へ誘導します。処方箋の再送依頼の理由も、画像の不備を示す固定文言で、内容を含みません。
- オンライン相談(`meet_consultation_v1`)は、参加リンクを含む唯一の例外で、契約判断で「受信者本人の参加リンクであり PHI ではない」と承認されています。
- 服薬フォローは、LIFF の回答ページへのリンク(`liff.line.me/...?page=pharmacy-followup&followUpId=...`)を付け、回答は LIFF 側で行います。
<!-- openwiki: broken internal link [/openwiki/workflows/line-webhook-and-outbound-delivery.md] link "/openwiki/workflows/line-webhook-and-outbound-delivery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- `isApprovedRenderedPharmacyMessage` は、Proxy が受け取った本文がテンプレートの描画結果と一致するかを検査します(→ [LINE webhook と送信配信](/openwiki/workflows/line-webhook-and-outbound-delivery.md))。

## 送信の関門: `sendPharmacyAutomatedPush`(`growth-loop/sender.ts`)

すべてのドメインの通知は、この関数に `messageId`・`category`・`retryKey` を渡して送ります。カテゴリは `transactional_care`・`followup_care`・`continuity`・`proactive_noncare` で、`proactive_noncare` だけに患者ごとの月間上限(`proactive_monthly_limit`)が掛かります(月は JST 境界)。結果は `sent`・`already_sent`・`in_progress`・`reconciliation_required`・`patient_blocked`・`operations_blocked`・`paused` のいずれかです。

処理の順序は、安全上の意味があります。

1. **capability の確認**: そのアカウントで該当機能が有効でなければ例外です。
2. **テナントの送信停止**(`outbound_messaging_paused_at`): 停止中なら `paused` で戻ります。**冪等キーの予約より前**に確認するので、停止中の試行が再試行キーや月間上限を消費せず、停止解除後に同じ通知を送れます。受信の処理は停止の影響を受けません。
3. **服薬フォローの運用体制**: 有効な運用設定と、主担当(と指定があれば副担当)の有効な人間スタッフが割り当てられていなければ `operations_blocked` です。
4. **患者の状態(1 回目)**: プライバシー同意が有効で、通知が停止されていないこと。ベータが有効なアカウントでは、有効な membership も必要です。
5. **冪等キーの予約**: `pharmacy_notification_events` に `attempted` 行を `INSERT OR IGNORE` します(キーは `(line_account_id, idempotency_key)`)。`proactive_noncare` は、同じ条件の中で月間件数が上限未満のときだけ挿入されます。既存行があれば、`sent` は `already_sent`、`attempted` で 15 分以内なら `in_progress`、15 分を超えていれば同じキーで再取得(結果不明の再試行)、24 時間を超えていれば人の確認に回す `reconciliation_required`、`failed` は上限内なら再取得、`blocked` は例外です。
6. **患者の状態(予約後と送信直前の 2 回)**と、`getFinalDispatchState`(最終の一括 SQL): 友だちがフォロー中か、アカウントとテナントが有効か、送信停止でないか、capability、代理権限(未成年は代理の同意が有効)、プライバシー撤回・通知停止・再開、ベータ membership の有効性などを 1 本の SQL で再確認します。ここで止まった場合、まだ LINE に届いていない試行は `failed`(再開可能)か `blocked` として記録します。**以前の「結果不明」の試行を消しません**。
7. **Proxy へ push**: 安定したリトライキーと `X-Pharmacy-Notification-Event-Id` を付けます。結果不明(タイムアウトや 5xx)は例外として伝え、行は `attempted` のまま残して、あとで同じキーで照合します。確定した失敗は `failed`、成功は `sent` に更新します。

つまり、テンプレート検査(Proxy)、冪等予約、状態の多重再確認が、それぞれ別の層で効きます。

## ドメインごとのキューと cron

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
cron からの呼び出しは [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md) にあります(5 分 tick と 6 時間 tick)。いずれも「LINE への送信が確認できた場合にだけ、業務の状態を進める」規則を共通に持ちます。

| ドメイン | 関数 | 内容 |
| --- | --- | --- |
| 服薬フォロー | `processDueMedicationFollowUps` | 期日の来た項目を `scheduled`→`due` に進め、送信して確認できたら `delivered` に遷移します。`notification_checked_at` で、停止中の項目が後続を塞がない処理順にします |
| 継続(次回受付の目安) | `deliverContinuityReminder` | `next-intake:<id>` を冪等キーとして送り、確認できた場合にだけ「案内済み」に更新します(楽観的な `expectedVersion`) |
| 処方箋の使用期限 | `processDuePrescriptionValidityReminders` | 期限前日の案内を送ります。期限を過ぎた確認済みの項目は、通知ではなく「期限確認が必要」に遷移させます。1 回あたり最大 100 件で、15 分を超えた古い請求は再取得します |
| 処方箋の状態 | `deliverPrescriptionNotification` と `retryFailedPrescriptionNotifications` | 状態変更イベントごとに 1 回送ります(`notification_sent` イベントで重複を防ぎ、より新しい状態が出ていれば `superseded`)。受付の同意(`readiness_notice_consent_at`)が前提で、準備完了の見込み時刻が未来のときだけ文面に入れます |

<!-- openwiki: broken internal link [/openwiki/concepts/database-and-migrations.md] link "/openwiki/concepts/database-and-migrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
継続・使用期限・服薬フォローの通知キューは、`custom_079`〜`081` の追加 migration が、部分インデックスと `notification_checked_at` 列を足して支えています(→ [データベースと migration](/openwiki/concepts/database-and-migrations.md))。ベータが有効なアカウントでは、キュー作成時に membership との紐付け(`getPharmacyBetaNotificationBinding`)を取り、送信時にその世代を再確認します(→ [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))。

## スタッフ向けの activity 通知

患者へ送る通知とは別に、薬局スタッフ向けの受信箱があります(`activity-notifications/`)。`prescription_received`・`prescription_status_changed`・`fulfillment_quote_created`・`myna_handoff_received` の 4 種が、アカウントごとに共有の 1 項目として作られます。

- 冪等キーは SHA-256 でハッシュ化して保存し(`(line_account_id, dedupe_hash)` の一意制約)、同じイベントは 1 項目にまとまります。同じキーで種別が違えば衝突として例外です。
- 状態は未確認と確認済みの 2 つだけで、応答にはハッシュ・患者識別子・LINE 識別子・処方内容・R2 キーを含めません。
- API は `GET /api/custom/pharmacy/activity-notifications` と `POST .../:id/ack` で、スタッフの認証、運用アカウントへのアクセス、`pharmacy_dashboard` capability を毎回サーバーで確認します。
- Web 管理画面の印刷は、Worker がプリンターへ接続せず、ブラウザの印刷ダイアログを開くだけの拡張です(`docs/pharmacy/PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md`)。

<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-patient-journeys.md] link "/openwiki/workflows/pharmacy-patient-journeys.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
関連: [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md)、[薬局の患者導線](/openwiki/workflows/pharmacy-patient-journeys.md)。

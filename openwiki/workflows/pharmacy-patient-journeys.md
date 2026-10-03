---
type: workflow
title: 薬局の患者導線(処方箋・問診・服薬フォロー・継続・EC・マイナ)
description: 薬局の患者向け各ドメイン(処方箋受付、問診、電子処方箋の引継ぎ、服薬フォロー、継続案内、緊急避妊の事前情報、履行見積り、利用状況タイムライン)の状態遷移、LIFF と管理画面 API の対応、共通の認可・冪等・後方互換の設計を説明する。
tags: [prescriptions, intake, medication-followup, continuity, emergency-contraception, myna, timeline, state-machine]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-b97295c8f7234c2d01a8df06
    resource: repo://apps/worker/src/custom/pharmacy/continuity/next-intake.ts
  - id: openwiki-source-a1afbed3f7d7681b007f7064
    resource: repo://apps/worker/src/custom/pharmacy/emergency-contraception/policy.ts
  - id: openwiki-source-a59930ac0374056870609eb1
    resource: repo://apps/worker/src/custom/pharmacy/emergency-contraception/repository.ts
  - id: openwiki-source-e9b1086cc4a63e88677dd0b0
    resource: repo://apps/worker/src/custom/pharmacy/fulfillment/repository.ts
  - id: openwiki-source-1cd708c7930e430c1addd36f
    resource: repo://apps/worker/src/custom/pharmacy/medication-followup/repository.ts
  - id: openwiki-source-cc214ddc984f89879be2964b
    resource: repo://apps/worker/src/custom/pharmacy/myna/routes.ts
  - id: openwiki-source-8bae1576d6c4f366336884ab
    resource: repo://apps/worker/src/custom/pharmacy/myna/state.ts
  - id: openwiki-source-935df47da945acf3c3002865
    resource: repo://apps/worker/src/custom/pharmacy/patient-timeline/repository.ts
  - id: openwiki-source-994178e9facd090d393252c3
    resource: repo://apps/worker/src/custom/pharmacy/prescriptions/routes.ts
  - id: openwiki-source-a2eed8fe184a8402a4f2dfa1
    resource: repo://apps/worker/src/custom/pharmacy/prescriptions/state.ts
  - id: openwiki-source-9c3ba6f9e0194a755fae24e2
    resource: repo://docs/pharmacy/EC_PREVISIT_FORM.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# 薬局の患者導線

薬局固有のドメインは `apps/worker/src/custom/pharmacy/<domain>/` に、それぞれ `routes.ts`(API)と `repository.ts`(永続化)を持ちます。API は 2 つの面に分かれます。

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **患者面** `/api/liff/pharmacy/*`: LIFF が呼びます。LINE の ID トークンで本人性を確認し、`liffId` からアカウントを決め、患者と代理の権限(`patientAuthorityPredicate`)を検査します(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。ベータが有効なアカウントでは membership も必要です(→ [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))。
- **スタッフ面** `/api/custom/pharmacy/*`: 管理画面が呼びます。`pharmacyAccountGuard` が `line_account_id` への割当を検査し、変更系は `expectedVersion`(または `expectedUpdatedAt`)による楽観ロックを要求します。

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
どのドメインも、状態を「許可された遷移表」で管理し、遷移を**イベント行**として残し、LINE 通知は**送信が確認できてから**状態を進めます(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。

## 処方箋の受付(`prescriptions/`)

患者が処方箋の画像を事前送信し、薬局が受付・準備・受け渡しを進めます。遷移は `state.ts` の表が正本です。

```
draft ──patient_submit──▶ received ──admin_accept──▶ accepted ──admin_ready──▶ ready ──admin_close──▶ closed
                              │  ▲                       │
       admin_request_resubmission  patient_resubmit        └─ admin_request_resubmission ─▶ needs_resubmission
                              ▼  │
                       needs_resubmission
（draft/received は patient_cancel、needs_resubmission/accepted/ready を含む各状態は admin_cancel で cancelled へ）
```

- 患者面: 下書き作成(`POST /prescriptions`)、画像の配置(`PUT .../files/:position`、R2 の private バケット)、提出・取消・再送信・来局通知(`.../arrival`)、履歴(`/me`)と復元(`/recovery`、`Cache-Control: private, no-store`)。
- スタッフ面: 一覧・統計、画像の private 取得(テナント配下のキーで、スタッフ認可後だけ)、`POST .../actions/:action` による遷移(受付・再送依頼・準備完了・完了・取消)。再送依頼の理由は固定コード(`blurred`・`cropped`・`glare`・`unreadable`・`missing_page`)です。
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 副作用: 状態変更ごとに患者へ通知(同意がある場合)、スタッフ向け activity 通知、履行見積りと使用期限の追跡、Web 印刷のタスク(`print/`)を伴います。画像の保持と削除は [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md) を参照してください。

### 履行見積り(`fulfillment/`)

受付ごとに、薬局が「用意できるか」の見積りを版(`revision`)付きで記録します。判定は `fulfillable`・`conditional`・`needs_confirmation`・`not_fulfillable`、要件(`requirements`、状態は `pending`/`satisfied`)、準備見込み時刻、受け渡し方法(`PICKUP`・`DELIVERY`・`HOME_VISIT`・`FACILITY_DELIVERY`)などを持ち、`expectedRevision` で競合を検出します。コード・制約の文字列は `^[a-z0-9_:-]{1,64}$` に制限し、臨床メモを入れない設計です。準備見込みは、通知文と KPI(予定内率)に使われます。

## 電子処方箋の引継ぎ(`myna/`)

マイナ保険証による電子処方箋は、患者がマイナポータル側で操作するため、薬局は**引継ぎ(handoff)**の状態だけを持ちます(実際の処方内容は取得しません)。

- 状態(`MYNA_HANDOFF_STATUSES`): `CREATED`・`LAUNCH_REQUESTED`・`PATIENT_REPORTED_COMPLETE`・`PATIENT_REPORTED_NO_PRESCRIPTION`・`SUPPORT_NEEDED`・`PAPER_FALLBACK`・`ABANDONED`・`EXPIRED`・`CLOSED`。
- 患者の申告(`COMPLETED`・`NO_PRESCRIPTION_FOUND`・`FAILED`・`SWITCH_TO_PAPER`)が状態へ写像され、`SWITCH_TO_PAPER` は申告済みの状態からも紙への切替を許します。
- 起動は短命のトークン付き URL `/r/myna/:token`(リダイレクト。Referrer を出さない厳しいヘッダを自分で設定)経由で、薬局側の `myna-endpoint`(起動 URL の設定と検証)は手動確認の証跡を持ちます(`docs/pharmacy/MYNA_LAUNCH_URL.md`)。
- スタッフは受領の確認結果(`E_PRESCRIPTION_RECEIVED`・`NO_RECORD_FOUND`・`PRESCRIPTION_EXPIRED` など)を `POST .../verifications` で記録します。受領できれば引継ぎは `CLOSED`、期限切れは `EXPIRED`、紙への切替は `PAPER_FALLBACK`、それ以外は `SUPPORT_NEEDED` に遷移します。

## 問診・患者登録(`intake/`)

患者(本人・家族・未成年の子)を登録し、同意を取り、問診に答えます。

- 患者の登録・更新(`/patients`)、プライバシー同意の付与と撤回、通知設定、アーカイブ、代理権限(`proxy-grant`)の解除。**撤回・停止に当たる操作はベータ参加の有無にかかわらず常に使えます**。
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 回答(`POST .../intake`)は項目暗号化して保存し(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))、スタッフの一覧は要約だけを返して、選んだ回答だけを復号します。
- スタッフ面は `binding-suspension`(LINE 紐付けの停止)と履歴の参照を持ちます。停止された患者には通知が送られません。
- 未成年(18 歳未満の子)は、有効な代理権限がなければ通知と操作の対象になりません。

## 服薬フォロー(`medication-followup/`)

処方箋が `closed` になった後、薬の使用開始後の体調を尋ねるフォローです。遷移は `repository.ts` の `TRANSITIONS` が正本です。

```
scheduled ─▶ due ─▶ delivered ─▶ no_issue ─▶ closed
   │          │         ├──────▶ concern ────────┐
   └▶cancelled└▶cancelled├─────▶ pharmacist_requested ─┤
                          │        ▼                    ▼
                          │     assigned ─▶ responded ─▶ closed
                          └▶ cancelled      └▶ escalated ─▶ responded
```

- `scheduled→due→delivered` は cron の通知処理(システム主体)が進めます。`delivered` 以降は、患者が LINE の postback(`pharmacy-followup:<id>:<no_issue|concern|pharmacist_requested>`)または LIFF で回答します(`POST /medication-followups/:id/respond`)。回答は冪等キーで一度だけ記録します。
- `concern`・`pharmacist_requested` は、スタッフが**有効な人間スタッフ**を担当に割り当て(`assigned`)、連絡(LINE または電話)の結果コードを記録して `responded`/`escalated`→`closed` へ進めます。共有アカウント主体は担当になれません。
- 運用設定(`operations`)で主担当・副担当が有効でなければ通知自体が送られません(`operations_blocked`)。遷移は `expectedVersion` で競合を検出し、担当者未指定の旧ペイロードは互換のため一定期間許されます(コード内で `ponytail:` として注記)。

## 継続案内(`continuity/`)

処方が完了した患者に「次回の受付の目安」を提案して、時期が来たらリマインドします(`next-intake.ts`)。

- 状態: `offered`・`accepted`・`active`・`reminded`・`linked`・`fulfilled`・`paused`・`ended`。スタッフが継続の義務(`obligation`)に対して目安を提示し(`POST .../expectations`、冪等キー付き)、患者が応答・一時停止し、スタッフが終了できます。
- 提示の元になる処方箋は `closed` であることが前提です。cron の `claimDueNextIntakeExpectations` が時期の来た項目を確保し、`deliverContinuityReminder` が送って、確認できたときだけ `reminded` に更新します。`linked`・`fulfilled` を含む継続の状態は、患者のタイムラインに投影されます。

## 緊急避妊薬の事前情報(`emergency-contraception/`)

LIFF で来局前に情報を収集し、**対面指導は必ず行う**ことを前提とした「下書き」です(`docs/pharmacy/EC_PREVISIT_FORM.md`)。販売可否の判断ではなく、最終判断と販売記録は研修修了薬剤師が行います。

- `policy.ts` の `assessEmergencyPrecheck` が、性交からの 72 時間の期限、来局予定・対面服用への同意・安全な連絡手段の有無から、仮受付を作れるか(`canCreateProvisional`)と、ブロック理由(`patient_presence_required`・`in_person_dose_required`・`outside_72_hours`)、リスクフラグ(16 歳未満、短期間の反復購入、通知不能など)を返します。詳細な既往・妊娠の可能性などは暗号化した payload の中だけに保存し、平文の `risk_flags_json` には要約の `pre_review_flagged` だけを置きます。
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 状態: `provisional`→`reviewed`→`completed`、または `cancelled`・`expired`(期限切れは自動)。スタッフ面は、薬剤師の登録、受付枠、在庫、提供可否の設定、遷移、販売記録(`.../sale`)を持ちます。この導線の通知は「ご相談」と中立に書き、保持期限(`retention_days`)を過ぎた payload は 6 時間 cron が redact します(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。

## 利用状況タイムライン(`patient-timeline/`)

患者が LIFF の「利用状況」で、複数ドメインの進み具合を 1 か所で見られるようにする**読み取り専用**の投影です(`GET /api/liff/pharmacy/timeline`)。処方箋・電子処方箋・継続・服薬フォロー・問診・手動チャットの各ドメインについて、元の状態を、患者向けの 6 つの状態(`pending`・`action_required`・`in_progress`・`completed`・`cancelled`・`unknown`)と次の行動(`open_detail`・`wait`・`review_required`・`none`)に、表で写像します。表に無い状態は `unknown` と詳細を開く導線に倒します。各行は患者の権限と `line_account_id` で絞り、内容は返さず、詳細画面へのパスだけを返します。

## 管理画面との対応

<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
管理画面の `apps/web/src/app/` には、`prescriptions`・`patient-intakes`・`continuity`・`emergency-contraception`・`myna`・`data-subject-requests`・`pharmacy-info` などのページがあり、`apps/web/src/custom/pharmacy/<domain>/` の部品が上の API を呼びます。LIFF 側の対応するページは `apps/liff/src/custom/pharmacy/<domain>/` にあります(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md))。当日の対応は、対応キューがドメイン横断で件数と期限を示します(→ [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))。

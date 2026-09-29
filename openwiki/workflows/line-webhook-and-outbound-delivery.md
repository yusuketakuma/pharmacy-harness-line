---
type: workflow
title: LINE webhook と送信配信
description: LINE webhook の検証と durable inbox による受信・再実行、薬局モードでの受信処理、LINE Harness Proxy 経由の送信(手動送信の source=manual と薬局の自動通知の承認)、outbound_line_deliveries による配信の追跡と再試行を説明する。
tags: [line, webhook, durable-inbox, proxy, outbound-delivery, idempotency, retry]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-95e75cc1593286d378f0f9d7
    resource: repo://apps/worker/src/routes/integrations/line-proxy.ts
  - id: openwiki-source-4627e3b2b46d09d1b3164698
    resource: repo://apps/worker/src/routes/integrations/webhook.ts
  - id: openwiki-source-82d67f15716c3d4e906533bf
    resource: repo://apps/worker/src/services/line-proxy-send.ts
  - id: openwiki-source-bf8bfb3288a2453c7d3ecfdd
    resource: repo://apps/worker/src/services/outbound-line-delivery.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# LINE webhook と送信配信

LINE との入出力は、受信(webhook)と送信(push/reply/broadcast)で別の仕組みですが、どちらも「途中で落ちても失われず、二重にも送られない」ことを狙って作られています。

## 受信: `POST /webhook`

`routes/integrations/webhook.ts` の処理順は次のとおりです。認証・検証に失敗した場合は、LINE に再送させないため(と、攻撃者に情報を与えないため)多くの場合 `200 {"status":"ok"}` を返して破棄します。

1. **サイズ制限**: `Content-Length` が 1 MiB を超えれば 413。宣言が無くても、読み取り中に上限を強制します(署名検証の前に巨大な本文を読ませないため)。
2. **署名長の事前判定**: LINE の署名は HMAC-SHA256 の base64 で 44 文字です。長さが違えば D1 も HMAC も使わず破棄します。
3. **宛先の解決**: 本文の `destination`(bot の userId)は**未検証の選択子**として、`pharmacy_line_channel_identities` から有効なアカウントとテナントを 1 件引くだけに使います。全テナントの秘密を総当たりせず、署名検証は 1 回で済みます。
<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
4. **署名検証**: 解決したアカウントの `channel_secret` を暗号化ストアから読み(→ [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md))、生の本文に対して検証します。資格情報が無ければ処理しません。
5. **durable な受信記録**: 各イベントを `pharmacy_webhook_event_receipts` に `INSERT OR IGNORE`(キーは `tenant_id, line_account_id, webhook_event_id`)します。LINE に成功を返す**前**に保存するので、その後に isolate が落ちてもイベントは失われません。保存に失敗したら 5xx を返し、LINE の再送に任せます。すでに存在する ID は再配信として二重処理しません。
6. **非同期処理**: `waitUntil` で、保存したイベントを `runWebhookInboxEvent` により順に処理します。LINE は約 1 秒以内の応答を求めるためです。

### inbox の状態遷移

`runWebhookInboxEvent` は、リクエスト時の処理と cron の復旧の両方が通る唯一の処理経路です。

- 行を `processing` に更新して**リース**(5 分)を取り、`claim_token` と `retry_count` を進めます。取れなければ `skipped`(別の実行が処理中か完了済み)です。
- 処理中は 1 分ごとにリースを延長(ハートビート)します。
- ハンドラが成功すれば `completed`、例外なら `failed` に設定します。いずれも、自分の `claim_token` を持つ行だけを更新するので、リース切れ後に別の実行が奪った行を上書きしません。行は削除しません。
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 失敗の詳細は本文を含まない固定キーでログに出します(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`sweepWebhookInbox`(5 分 cron、→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))は、まず `retry_count` が 10 に達した行と、24 時間以上未着手のまま残った行を dead-letter として退役させ(生ペイロードが永久に残らないため)、次に期限切れのリースを持つ未完了の行を最大 50 件まで古い順に再実行します。完了済みまたは dead-letter 済みの受信記録は 30 日を過ぎると 6 時間 cron の `purgeWebhookEventReceipts` が削除します。未完了で dead-letter にもなっていない行は消しません。

### 薬局モードでの受信処理

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`handleEvent` は、アカウントが薬局モードなら generic CRM の自動処理を止めます(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

- **follow**: 友だち登録と Growth Loop の初回フォロー指標(`recordPharmacyFollow`)を記録し、その後のマイル付与・流入経路・自動返信・シナリオ登録は行いません。
- **postback**: 服薬フォローの回答(`handleMedicationFollowUpPostback`)だけを処理し、auto-reply には回しません。
- **text メッセージ**: 受信ログ(`messages_log`、`source='user'`)を記録し、チャットを未対応として更新して終了します。自動返信もシナリオもありません。人が個別チャットで返信します。
- **text 以外(画像・スタンプなど)**: 受信ログを記録し、薬局モードではマイル付与をせず、チャットを未対応に戻して終了します(解決済みの後に画像だけ送られた場合に、未対応一覧から落ちないようにするため)。
- **unfollow**: 友だちの状態を更新し、薬局の指標を記録します。

受信ログの ID は `webhookEventId` から決定的に作るので、再実行しても行が重複しません。

## 送信: LINE Harness Proxy

LINE への push は、Worker 自身も外部エージェントも、`/line-api/v2/bot/**` の**互換プロキシ**(`routes/integrations/line-proxy.ts`)を通します。ベース URL を `api.line.me` から `https://<worker>/line-api` に替えるだけで、送信が `messages_log` に記録され、管理画面のチャット履歴から抜けません。プロキシ側が履歴を書くので、呼び出し側が二重に書いてはいけません。

認証は 2 系統です。(1) チャネルアクセストークン(暗号化ストアのダイジェストで照合。未登録は 401 で、オープンリレーを防ぐ)、(2) Harness の API キー(Worker が保持するチャネルトークンで上流を呼ぶ。複数アカウントは `X-Line-Account-Id` で指定)。記録対象は push・multicast・broadcast で、reply と narrowcast は転送のみです。

### `X-Line-Harness-Source: manual`

担当者が 1 対 1 で返信するときは、このヘッダに `manual` を付けます(`CLAUDE.md` の運用規則)。`manual` は push だけに許され、それ以外の値や push 以外のパスは 400 です(一斉配信で未対応をまとめて消す事故を防ぐため)。ヘッダが無ければ従来どおり `external` で記録します。予約通知などの自動送信には付けません。`manual` の push は追跡付き(`trackedManual`)で送り、薬局アカウントでは担当スタッフとして認可された呼び出し元だけを許可します。

### 薬局の自動送信ゲート

薬局モードのアカウントでは、`rejectUnsafePharmacySend` が自動送信を次の条件で絞ります。

- アカウントが特定できない場合、薬局が 1 つでもあるインストールでは 403(アカウント指定が必須)。
- `manual` 以外は、`/v2/bot/message/push` のみ許可し、他の送信(multicast/broadcast など)は「generic な自動送信は無効」で 403。
- `X-Pharmacy-Notification-Event-Id` が必須で、`pharmacy_notification_events` に `outcome='attempted'` の行があり、宛先の LINE ユーザーが一致し、メッセージがちょうど 1 件で、`isApprovedRenderedPharmacyMessage` が承認済みテンプレートの描画結果と認めた場合だけ通します。
- リトライキーは、そのイベントの冪等キーから決定的に作った値と一致しなければ拒否します。

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
つまり、薬局の自動通知は、事前に承認済みテンプレートとして記録されたものしか LINE に届きません(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。

### Worker から Proxy への呼び出し

`services/line-proxy-send.ts` の `pushViaHarnessProxy` は、必ず `X-Line-Retry-Key` を付けて Proxy に push します。10 秒でタイムアウトし、タイムアウトや 5xx は「結果不明」(`LineHarnessUnknownOutcomeError`)として区別します。4xx は確定した失敗です。同じリトライキーで LINE が 409 と受理済みのリクエスト ID を返せば成功として扱います。Worker 内からの呼び出しは、HTTP を介さず同一プロセスの Proxy へ直接ディスパッチできます(`dispatchLineProxyLocally`)。

## 配信の追跡と再試行

`services/outbound-line-delivery.ts` は、push・reply・broadcast を `outbound_line_deliveries` の 1 行で追跡します(`open` → `accepted` または `retired`)。要点は次のとおりです。

- **冪等**: 操作 ID ごとに行を用意(`prepareDelivery`)し、すでに `accepted` なら `already_sent`、`retired` なら `reconciliation_required` を返して送りません。送信前に `attempt_count` を条件付き UPDATE(`outcome='open'` かつ期限内)で進め、他の実行と競合したら送らずに現状で判断します。
- **リトライキー**: LINE の `X-Line-Retry-Key` を使い、同じ論理配信の再送が二重配信にならないようにします(`createLineRetryKey` は論理配信から決定的な UUID を作る)。再試行の地平は 24 時間から安全マージン 1 分を引いた範囲で、reply はトークンの寿命が短いため約 65 秒です。
- **結果不明の扱い**: 送ったか分からない場合は、次の cron が同じキーで再試行するか、期限が来たら `retired`(`reconciliation_required`)として人の確認に回します。盲目的に別の送信をしません。
- **cron の照合**: 5 分 cron が、テスト送信の照合、受理済みだが記録が未完のシナリオ reply の照合、未送信のシナリオ reply の照合、期限切れの退役を、1 回あたり 100 件までで行います。
<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **一斉配信**(`services/broadcast.ts`、generic 機能): 配信キューと分割送信、復旧(停止・固着した配信)、再試行キーを持ちます。薬局モードでは generic の配信 cron 自体が止まります(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。

## 関連テスト

<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`webhook.test.ts`、`webhook-durable-inbox.test.ts`、`webhook-pharmacy-mode.test.ts`、`webhook-pharmacy-lifecycle.test.ts`、`line-proxy.test.ts`、`line-proxy-send.test.ts`、`outbound-line-delivery.test.ts`、`broadcast-retry-key.test.ts` が対応します(→ [テストと検証](/openwiki/operations/testing-and-verification.md))。

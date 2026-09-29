---
type: architecture
title: Worker のリクエスト処理と cron
description: Worker の Hono アプリの middleware 順序、静的アセット配信と SPA フォールバック、エラー処理、scheduled ハンドラの 5 分/6 時間 cron ごとの処理と薬局モード時の制限を説明する。
tags: [worker, hono, middleware, cron, scheduled, cloudflare]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-89dbbb06ce93ef867c763a22
    resource: repo://apps/worker/src/custom/pharmacy/cron-access.ts
  - id: openwiki-source-36b9b14daad5e37bc5cb3676
    resource: repo://apps/worker/src/index.ts
  - id: openwiki-source-deee7098a6d2b63b419cf0e4
    resource: repo://apps/worker/src/lib/app-error-handler.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# Worker のリクエスト処理と cron

<!-- openwiki: broken internal link [/openwiki/architecture/system-overview.md] link "/openwiki/architecture/system-overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`apps/worker/src/index.ts` は 1 つの Hono アプリと `scheduled` ハンドラを export します(全体像は [システム全体構成](/openwiki/architecture/system-overview.md))。

## middleware の順序

`app.use` の登録順がそのまま実行順です。順序自体が安全性の要件になっています。

1. **CORS**: `/api/public/media-inquiries` だけ専用の許可リスト(メディアサイトの origin)で、管理 API には広げません。それ以外は資格情報付きなのでワイルドカード不可で、同一 origin と `ADMIN_ORIGIN`/`LIFF_ORIGIN` の許可リストだけを反映します。Bearer の SDK/MCP は Origin を送らないので影響を受けません。
2. **`securityHeadersMiddleware`**: `next()` の後で `X-Frame-Options: DENY`・`frame-ancestors 'none'`・`nosniff`・`Referrer-Policy` を、まだ設定されていない場合にだけ付けます。myna リダイレクトのようにより厳しい値を自分で設定するルートはそれが残ります。
3. **`rateLimitMiddleware`**: 認証より前で乱用を止めます。
4. **`authMiddleware`**: `/webhook` と `/docs` などを除いて認証します。`/api/platform-admin/*` は認証ミドルウェアが素通りし、専用の `platformAdminAuthMiddleware` が唯一の関門になります。テナントに紐づかない役割なので、テナント系ガードより前に登録されています。
<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
5. **テナント系ガード**: `pharmacyTenantApiAllowlistGuard` の後に `tenantAccountSelectorGuard`・`tenantFriendResourceGuard`・`tenantScenarioResourceGuard`・`tenantRichMenuResourceGuard` が続き、他テナントの `line_account_id` や資源 ID を、ルートが使う前に拒否します。`/api/custom/pharmacy/*` にはさらに `pharmacyAccountGuard` が、ログイン中のスタッフがそのアカウントに割り当てられていることを確認します(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。
6. **薬局モードでの generic 機能の遮断**: `PHARMACY_DISABLED_GENERIC_API_PREFIXES` の各プレフィックスに `pharmacyGenericFeatureGuard` を、コレクションと子ルートの両方に掛けます(Hono の `/*` はコレクション自身に一致しないため)。`/api/chats`・`/api/friends/*` には `pharmacyManualChatMutationGuard` を掛けます。

その後 `app.route('/', ...)` で generic ルート群と薬局ルート群(`// custom:pharmacy-...` コメント付き)を登録します。

## 静的アセットと未定義ルート

最後の catch-all は、リンクプレビュー用 bot の User-Agent には OGP 用 HTML を返し、それ以外は `ASSETS` バインディングから静的ファイルを返します。`ASSETS` が無い環境(新規 clone、vitest)では `TypeError` にせず 404 JSON を返します。アセットが 404 で、かつ `Accept: text/html` の GET なら `index.html` を返して LIFF の深いリンクをクライアントルーターに任せます。`.js`/`.png` などは 404 のままです。

<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`app.notFound(notFoundHandler)` と `app.onError(appErrorHandler)` が仕上げです。`appErrorHandler`(`lib/app-error-handler.ts`)は `HTTPException` 相当の `getResponse` を持つエラーはそのレスポンスを返し、それ以外はルートとメソッドとステータスだけを固定キーでログに出し、本文は `Internal Server Error` の 500 にします。例外の内容(患者データを含み得る)をログや応答に出さないための設計です(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。

## scheduled ハンドラ

`scheduled` は `event.cron` で処理を分けます。冒頭でアクティブなテナントの LINE アカウントを取得し、`shouldRunGenericCron` で generic cron を走らせるか決めます。この関数は、アクティブなアカウントが 0 件、または 1 件でも薬局モードなら `false` を返します。generic と薬局が混在する構成はサポートせず、混在時は generic の cron を止める(fail-closed)という意図です(コード内に `ponytail:` コメントで残されています)。

### 毎 tick(5 分・6 時間とも)

まず LINE アクセストークンの更新を、薬局モードかどうかに関係なく実行します。リマインダーが失効直後のトークンで 401 にならないよう、リマインダーより先に済ませる順序です。`runGenericCron` のときだけ、ブロードキャストの復旧、予約・イベント予約・Meet 個別相談・ウェビナーのリマインダー(時刻厳守で軽いので重い配信ジョブより先)、その後に配信系(ステップ配信、予約配信、リマインダー配信、キュー配信、アカウント健全性チェック)を並列実行します。

### `*/5 * * * *`

- outbound LINE 配信の照合(テスト送信・シナリオ・未送信の照合と期限切れの掃除)。
<!-- openwiki: broken internal link [/openwiki/workflows/line-webhook-and-outbound-delivery.md] link "/openwiki/workflows/line-webhook-and-outbound-delivery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **webhook durable inbox の sweep**: 保存されたが完了しなかった webhook イベントを再実行します。薬局アカウントを含む全テナントで走り、各アカウント自身の受信イベントだけを扱います(→ [LINE webhook と送信配信](/openwiki/workflows/line-webhook-and-outbound-delivery.md))。
- 薬局の各プロセッサ: 服薬フォロー、EC ステータス通知、myna 期限、EC リマインダー(失敗は固定文言でログ)。
- `runGenericCron` のときだけマイレージのキュー処理(1 バッチ最大 100 件)。

各ジョブは Promise の配列に積まれ、`Promise.allSettled` で待つので、1 つの失敗が他を止めません。

### `0 */6 * * *`

<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
webhook inbox の purge、処方箋の期限切れ画像掃除、EC 問診の保持期限超過の purge、処方箋通知、継続(次回受付予定)リマインダー、処方箋の有効期限リマインダーが薬局側で走ります。`runGenericCron` のときは加えて、フォロー中マイレージの節目、予約の期限切れ処理、イベント予約の期限切れ処理が走ります。薬局側の通知は承認済み PHI-free テンプレートのみを、LINE Harness Proxy 経由で送ります(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。

この cron が 2 系統だけなのは、追加の Cron Trigger を増やさずに D1 負荷を一定にするためで、コード内でも同旨が説明されています。

## 関連テスト

<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`security-headers.test.ts`、`not-found.test.ts`、`scheduled-meet-reminders.test.ts`、`custom/pharmacy/cron-access.test.ts` が対応します(→ [テストと検証](/openwiki/operations/testing-and-verification.md))。

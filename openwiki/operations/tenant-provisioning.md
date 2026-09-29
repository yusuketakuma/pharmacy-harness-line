---
type: operations
title: テナント作成と運用スクリプト
description: 薬局テナントを作成する API と pnpm スクリプト(setup・platform admin・LINE 資格情報の移行・設定管理)、LINE 資格情報の暗号化保管、設定診断(configuration doctor)と readiness の判定を説明する。
tags: [provisioning, tenant, scripts, line-credentials, readiness, operations]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-9b46b443bd9cc07348852d02
    resource: repo://apps/worker/src/custom/pharmacy/configuration-doctor.ts
  - id: openwiki-source-ead4e4b1070385637d1d4bd3
    resource: repo://apps/worker/src/custom/pharmacy/provisioning/line-credential-backfill.ts
  - id: openwiki-source-3ce34f8059b88a8f98a63f29
    resource: repo://apps/worker/src/custom/pharmacy/provisioning/line-credentials.ts
  - id: openwiki-source-24261fee6c8c9ee2c077e3f1
    resource: repo://apps/worker/src/custom/pharmacy/provisioning/routes.ts
  - id: openwiki-source-847fb38e5f21f85e36db6855
    resource: repo://apps/worker/src/custom/pharmacy/readiness.ts
  - id: openwiki-source-33a1cf1be9e7331d4768c51e
    resource: repo://scripts/custom/pharmacy/bootstrap-tenant-admin.ts
  - id: openwiki-source-6617d3e9fcf0e1a21ce5532c
    resource: repo://scripts/custom/pharmacy/manage-tenant-settings.ts
  - id: openwiki-source-1c85db757fca37dac6c07b33
    resource: repo://scripts/custom/pharmacy/migrate-line-credentials.ts
  - id: openwiki-source-56ce82b8ec86b3203cd3c9f4
    resource: repo://scripts/custom/pharmacy/setup-tenant.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# テナント作成と運用スクリプト

薬局(テナント)の作成や LINE 資格情報の投入は、管理画面のセルフサービスではなく、**platform admin の権限でサーバー API を呼ぶ**形で行います。`scripts/custom/pharmacy/` の CLI はその API の薄いクライアントで、実体は `apps/worker/src/custom/pharmacy/provisioning/routes.ts` にあります。日々の画面操作は `docs/pharmacy/OPERATION_GUIDE.md`(担当者向けの運用ガイド)と `manual-staff.md` が別にあります。

## pnpm スクリプト

| コマンド | 内容 |
| --- | --- |
| `pnpm tenant:setup` | テナント・LINE アカウント・LIFF の作成 (`POST /api/platform/pharmacy/tenants`) |
| `pnpm platform:admin-bootstrap` | 最初の platform admin の作成 (`POST /api/platform/pharmacy/platform-admins`) |
| `pnpm tenant:line-credentials` | LINE 資格情報の `backfill` / `scrub` / `restore`(段階移行) |
| `pnpm tenant:settings` | platform admin としてテナントの設定 API を読み書き(変更は既定で dry-run) |
| `pnpm tenant:admin-bootstrap` | **廃止**。実行すると廃止を告げて終了コード 1 を返す |

共通の書き方は、`--dry-run`、`--help`、必須の secret は環境変数で渡す(コマンドラインに出さない)、`cli-common.ts` の `requestId`・`required`・`workerOrigin` を使う、です。

### テナントの作成

`tenant:setup` には `--worker-url`・`--tenant-name`・`--admin-name`・`--line-channel-id`・`--line-name`・`--line-login-channel-id`・`--liff-id` を渡し、`PHARMACY_PLATFORM_ADMIN_KEY`・`PHARMACY_LINE_CHANNEL_ACCESS_TOKEN`・`PHARMACY_LINE_CHANNEL_SECRET`・`PHARMACY_LINE_LOGIN_CHANNEL_SECRET` を環境変数で渡します。Worker 側には `PLATFORM_ADMIN_KEY`・`CROSS_ACCOUNT_TOKEN_KEY`・`LINE_CREDENTIAL_KEY_V1` を `wrangler secret put` で設定しておく必要があります。

サーバーの `provisionTenant` は次の性質を持ちます。

- **冪等**: `Idempotency-Key`(英数字・`._:-`、8〜128 文字)が必須です。同じキーで同じ内容の再送は、記録済みの結果を `replayed` として返します。同じキーで内容が違えば 409 です。応答を取り逃がしたときは同じキーで再実行します。薬局コードはサーバーが発行するため、控え忘れも同じキーで復元できます。
- **入力の検証**: LINE のアクセストークンを `/v2/bot/info` で確認して bot の識別子を取得し、失敗すれば 400 です。公開 URL の設定が無ければ 503 です。
- **監査**: platform admin 経由の場合は `tenant_provision_replay` などの操作を記録します。

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
個別のテナント管理者資格情報や CLI セッションを作る旧経路(`admin-bootstrap`、`cli-sessions`)は 410 で廃止されています。共通パスワードは platform admin 画面から発行・再発行します(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。

### platform admin の初期作成

`platform:admin-bootstrap` は、`/api/platform-admin/login` が資格情報の行を必要とするため鶏と卵になる最初の 1 人を作るための入口です。`PHARMACY_PLATFORM_ADMIN_KEY` で保護され、以後のこの管理者の操作は `platform_admin_access_events` に記録されます。

### 設定の読み書き

`tenant:settings` は `--tenant-id`・`--account-id`・`--path`・`--method` を取り、変更系(POST/PUT/PATCH/DELETE)は既定で dry-run です。次のような制約があります。

- `/api/auth`・`/api/integrations`・`/api/liff`・`/api/platform`・`/api/public` で始まるパスは拒否します。
- 呼べるのは `platform-admin/api-coverage.ts` の「管理 API のカバレッジ表」に載っている経路だけです(Worker 側の許可判定と同じ表を共有)。
- リッチメニューの既定・公開・ロールバックの専用フラグがあります。

## LINE 資格情報の保管

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
LINE のチャネルアクセストークンとシークレットは、平文の列ではなく暗号化して保管します(`provisioning/line-credentials.ts`)。種別は `channel_access_token`・`channel_secret`・`login_channel_secret` の 3 種で、`LINE_CREDENTIAL_KEY_V1` から導出した鍵で AES-GCM 暗号化します。AAD に `tenantId`・`lineAccountId`・種別を含めるため、他テナントへの差し替えは復号できません。アクセストークンだけは、受信 webhook の照合用に検索ダイジェストを持ちます。`readLineCredential` などが `line-credential-store.ts` にあり、Worker の cron や送信処理はこれでトークンを読みます(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。

旧来の平文列からの移行は `tenant:line-credentials` の 3 段階です。

1. `backfill`: 暗号化して保存する(旧列は残る)。
2. `scrub`: 旧列を sentinel(`encrypted:v1`)へ置換する。`--confirm-scrub` が必須。
3. `restore`: sentinel を暗号文から復号して旧列へ戻す(ロールバック用)。`--confirm-restore` が必須。

<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
問診の項目暗号化と同じ「追加→検証→scrub→必要なら restore」の型です(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。

## 設定診断(configuration doctor)と readiness

作成した薬局が本当に使える状態かは、2 つの純粋な判定で確認します。どちらも `READY`・`BLOCKED`・`UNVERIFIED` の状態と、理由コードの一覧を返します。

- **readiness**(`readiness.ts`): 電子処方箋(エンドポイントの設定と 24 時間以内の確認)、緊急避妊(要件の完備・研修済み薬剤師・在庫・将来の受付枠)、リッチメニュー(レイアウト・保存版・カタログ版の鮮度・アップロードと既定の読み戻しの確認)の 3 機能ごとに、`ELECTRONIC_ENDPOINT_MISSING`、`EMERGENCY_INVENTORY_UNAVAILABLE`、`RICH_MENU_CATALOG_STALE` などの理由コードを出します。
- **configuration doctor**(`configuration-doctor.ts`): その上位で、テナントの対応・有効性、スタッフ割当、capability 設定、bot 識別子、LIFF ID と公開 origin、ログインチャネル、メッセージ/ログイン資格情報の有無と検証(`LINE_CREDENTIAL_UNVERIFIED`)を確認し、readiness の理由コードも取り込みます。資格情報の実際の有無は `readLineCredential` で確かめますが、値は返しません。

<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
「未確認」を「大丈夫」と扱わないことが設計の要点で、外部(LINE や薬局の手動確認)の状態が確かめられていなければ `READY` にせず `UNVERIFIED` にします(→ [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))。

## 配備との関係

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
これらのスクリプトは本番を変更する操作なので、実行には明示的な承認が必要です。配備そのものの流れは [リリースとデプロイ](/openwiki/operations/release-and-deploy.md) にあります。スクリプトの単体テストは各ファイルの隣(`*.test.ts`)にあります。

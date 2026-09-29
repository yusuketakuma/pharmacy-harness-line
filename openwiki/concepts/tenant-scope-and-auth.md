---
type: concept
title: テナントスコープと認証・認可
description: 薬局管理画面のテナント別パスワードセッション(Cookie + CSRF)、ログイン試行の throttle、連携用 Bearer、platform admin の別系統セッションとサポート権限、LIFF の ID トークン検証、line_account_id による認可の原則を説明する。
tags: [auth, session, csrf, tenant, platform-admin, liff, throttle]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-003a2664da71e11b665cb6ed
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/access.ts
  - id: openwiki-source-ea1c98f1318932cfe740b45c
    resource: repo://apps/worker/src/custom/pharmacy/platform-admin/access-grant.ts
  - id: openwiki-source-a42d8dd256fb150ec061d10d
    resource: repo://apps/worker/src/custom/pharmacy/platform-admin/auth.ts
  - id: openwiki-source-1a50886ab09151135e8a9ac9
    resource: repo://apps/worker/src/custom/pharmacy/provisioning/auth-policy.ts
  - id: openwiki-source-83d52aa1932ca41605033ab0
    resource: repo://apps/worker/src/custom/pharmacy/provisioning/auth-throttle.ts
  - id: openwiki-source-1ea6054996df7e00b26d9a67
    resource: repo://apps/worker/src/middleware/auth.ts
  - id: openwiki-source-9fed2a188727b3235b21a367
    resource: repo://apps/worker/src/routes/admin/admin-auth.ts
  - id: openwiki-source-2b5522ce2b690c8c6e266bc8
    resource: repo://apps/worker/src/services/liff-auth.ts
  - id: openwiki-source-44a228a11f0f695a0f2daba2
    resource: repo://docs/pharmacy/ADMIN-AUTH.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# テナントスコープと認証・認可

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
このシステムには 4 種類の「呼び出し元」があり、それぞれ認証の仕組みが別です。共通の原則は「リクエストが指定する ID(`line_account_id`・`liffId`・`X-Tenant-Id`)は**選択子**にすぎず、権限の根拠はサーバーが引く認証済みの状態(セッション・メンバーシップ・割当)である」ことです(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

| 呼び出し元 | 認証 | 主なコード |
| --- | --- | --- |
| 薬局スタッフ(管理画面) | 薬局コード + テナント共有パスワード → HttpOnly セッション Cookie | `routes/admin/admin-auth.ts`、`middleware/auth.ts` |
| SDK / MCP などの連携 | `Authorization: Bearer` + `X-Tenant-Id` | `middleware/auth.ts` |
| platform admin | 別テーブル・別 Cookie の専用セッション | `custom/pharmacy/platform-admin/auth.ts` |
| 患者(LIFF) | LINE の ID トークン | `services/liff-auth.ts` |

## スタッフのログインとセッション

ブラウザのログインは `POST /api/auth/login { pharmacyCode, password }` です。スタッフ個人のログイン ID や API キーでのブラウザログインは廃止されており、`loginId` や `apiKey` を含む本文は拒否されます(正本: `docs/pharmacy/ADMIN-AUTH.md`)。Worker は有効なテナント、その共有管理者資格情報(`principal_kind = 'pharmacy_shared'` かつ `shared_tenant_id` が一致)、対応するメンバーシップを検証し、3 つの Cookie を返します。

- `lh_admin_session`: 不透明なセッショントークン(HttpOnly・Secure)。
- `lh_tenant`: テナントの束縛(HttpOnly)。毎リクエストでセッション記録と照合します。
- `lh_csrf`: CSRF トークン。本文でも返します。

<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
変更系メソッド(POST/PUT/PATCH/DELETE)は `X-CSRF-Token` ヘッダが `lh_csrf` Cookie と一致しないと 403 です(ダブルサブミット)。管理画面(`*.pages.dev`)と API(`*.workers.dev`)がクロスサイトのとき、JS から API ドメインの Cookie を読めないため、トークンを本文にも載せてクライアントに保持させ、Worker が自分の Cookie と突き合わせます(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md))。

セッションの寿命は `provisioning/auth-policy.ts` が決めます。

| 種別 | 絶対期限 | アイドル期限 |
| --- | --- | --- |
| `bootstrap`(初期・一時パスワード) | 30 分 | 10 分 |
| `standard` | 8 時間 | 15 分 |

新規・一時パスワードは 15〜128 文字で、ローカルに版管理した上位 10 万件の一般的なパスワードと完全一致してはいけません。判定は外部の漏えい確認サービスに候補を送らずに行います。

### Cookie の SameSite とトポロジ

`ADMIN_ORIGIN`(許可 origin)、`ADMIN_ALLOW_CROSS_SITE`(クロスサイトなら `SameSite=None; Secure`)、`ADMIN_COOKIE_SAMESITE`(明示上書き)で設定します。管理画面と API がクロスサイトなのに SameSite が `None` でない場合、ログインは静かに壊れる代わりに、対処のわかる 500 で拒否します。同一サイトのカスタムドメイン運用が推奨で、Pages のプレビュー URL は `ADMIN_ORIGIN` に明示しない限り許可されません。

## ログイン試行の throttle

`provisioning/auth-throttle.ts` は `admin_login_throttles` テーブルで、`(realm, authorityId, 正規化した loginId)` ごとに失敗を数えます(realm は `tenant` か `platform_admin`)。`loginId` は NFKC 正規化・trim・小文字化します。15 分の窓の中で、失敗が重なるごとに次に許される時刻を 1 秒・2 秒・4 秒と段階的に遅らせ、失敗が一定回数に達すると 15 分ロックします。判定と更新は 1 本の `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` で原子的に行い、待機中やロック中は `allowed: false` になります。ログイン成功で該当行を消します。

## 連携用 Bearer と env-owner

SDK/MCP は `Authorization: Bearer <key>` と明示的な `X-Tenant-Id` を送れます。これは API 連携用の認証で、ダッシュボードへのログインの代替ではありません。ブラウザの API キーはセッション Cookie としてもログインとしても受け付けません。`API_KEY` で認証される `env-owner` も、`X-Tenant-Id` の解決には有効な `tenant_staff_memberships` 行が必要です。ヘッダはテナントを選ぶだけで、メンバーシップが権限の根拠です(`LEGACY_ENV_OWNER_BYPASS` は廃止済みで効果なし)。薬局のアカウント認可(`resolveAccessiblePharmacyTenant`)は `env-owner` を常に拒否します。

## テナントとアカウントの認可

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
認証後は、Worker の middleware がテナントを固定します(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。`tenantAccountSelectorGuard` などが他テナントの資源 ID を拒否し、`/api/custom/pharmacy/*` では `pharmacyAccountGuard` が、`line_account_id` へのアクティブな割当(または共有薬局主体のテナント一致)を 1 つの SQL で検証して、認証済みテナントと一致しなければ 403 にします。

## platform admin

platform admin はテナントに紐づかないため、テナント管理者のセッションとは Cookie(`lh_platform_admin_session`・`lh_platform_admin_csrf`)、CSRF ヘッダ(`x-platform-admin-csrf-token`)、テーブルまで完全に分けています。`/api/platform-admin/*` はテナント認証の middleware を素通りし、`platformAdminAuthMiddleware` だけが関門です。テナントスタッフのセッションや連携 Bearer は、この経路の権限になりません。

<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
既定のダッシュボード・テナント一覧・ログ・監査は PHI を含みません。患者の一覧・詳細は、目的付きの support-mode 権限(理由・チケット・現在のパスワードによる再認証・有効期限・常時表示バナー・明示的な終了)を、そのセッションに紐づけて開始した場合だけ見られます(`access-grant.ts`)。同じ管理者の別セッションが相乗りすることはできません。データ保護の recovery 操作は、承認者と実行者が別の principal であることを要求します(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。

## LIFF の認証

<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`verifyCallerLineIdentity` は Bearer の ID トークンを受け取り、未検証の JWT の `aud`(ログインチャネル ID)を**検索の手掛かりとしてだけ**使って、有効なテナントに属する有効な LINE アカウントを引きます。該当がちょうど 1 件でなければ拒否です。その後、LINE の `oauth2/v2.1/verify` に問い合わせ、`aud` の一致を確認してはじめて `lineUserId`・`lineAccountId`・`tenantId` を返します。認証の権威は常に LINE 側の検証で、トークンのサイズ上限(16 KB)や形式の不正は即拒否します。LIFF アプリ側はこの ID トークンと `liffId` を送るだけです(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md))。

## 関連

<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
テナントとスタッフの初期作成は [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md) にあります。

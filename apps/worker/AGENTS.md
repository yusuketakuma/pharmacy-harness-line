# apps/worker — Cloudflare Worker (Hono + D1)

ルートの `AGENTS.md` の規約が優先。API・LIFF 静的配信・LINE webhook・cron をここで処理する。

## 地図

| パス | 役割 | 触るとき |
|---|---|---|
| `src/index.ts` | アプリ組み立て: cors → rate-limit → auth → platform-admin auth → pharmacy allowlist → tenant 境界 → 各 route。`// custom:pharmacy-*` コメントが薬局の差し込み点 | ルート追加・ミドルウェア順序 |
| `src/custom/pharmacy/<feature>/` | **薬局機能の本体**(prescriptions / myna / intake / continuity / medication-followup / emergency-contraception / fulfillment / print / activity-notifications / public-profile / privacy-policy / data-subject-requests / rich-menu / growth-loop / provisioning / platform-admin)。各 feature は `routes.ts` + ドメインロジック + テスト | 薬局機能の変更はここ |
| `src/custom/pharmacy/{account,operations-access,cron-access,readiness,configuration-doctor}.ts` | テナント/アカウント解決、職員権限、cron ガード、readiness 判定 | 権限・診断 |
| `src/custom/pharmacy/logging-privacy.test.ts` | `src/**` の全ログ呼び出しを regex 検査(password/token/secret/line_user_id/answers…) | ログを追加したら必ず通す |
| `src/middleware/auth.ts` | テナント職員セッション、LIFF allowlist(method+path)、platform-admin Bearer 経路(`settings-scope.ts` で許可 path/method を限定) | 認証・allowlist |
| `src/middleware/{role-guard,tenant-boundary,rate-limit}.ts`, `deny.ts` | 役割・テナント境界・レート制限。401/403 は `deny(c, status, reason)` 経由で構造化ログ | 認可 |
| `src/lib/log.ts` | allowlist 方式の構造化 JSON ロガー(`log(event, fields, level)`)。allowlist 外のキーは捨てる | ログ出力はこれを使う |
| `src/lib/tenant-audit.ts` | `tenant_admin_audit_events` への監査行(`tenantAuditStatement`)。PHI・資格情報値は入れない | 管理操作・PHI 閲覧 |
| `src/lib/{validate-https-url,pagination,safe-redirect}.ts` | SSRF 防止 URL 検証、limit/offset クランプ、リダイレクト先 allowlist | 外部 URL / 一覧 / redirect |
| `src/routes/<domain>/` | フォーク元の汎用 CRM ルート(admin / crm / messaging / marketing / liff / booking / integrations)。詳細は `src/routes/README.md`。薬局モードでは middleware で fail-closed | 原則触らない。薬局機能をここに足さない |
| `src/services/` | 配信・予約・Google 連携などの汎用サービス(フォーク元) | 薬局向け通知は `custom/pharmacy/*` の PHI-free テンプレートを使う |
| `src/client/` | Worker が配信する汎用 LIFF クライアント(フォーク元) | — |
| `wrangler.toml` | バインディング・compatibility_date。実 ID は `wrangler.local.toml`(gitignore)か CI secrets | デプロイ設定(人間ゲート) |

## ルール

- 権限の根拠は常にサーバー側(session / staff 割り当て / LINE ID token 検証)。query/body の `line_account_id` や `tenant_id` を信用しない。
- 新しいクエリは `line_account_id`(または tenant)で scope する。他テナントの id を受け付ける API は存在してはならない。
- ログに PHI・秘密情報・request body・上流レスポンス本文を出さない(`log()` + `logging-privacy.test.ts`)。
- スキーマ変更は `packages/db/migrations/custom_0NN_*.sql` の追記のみ。
- テスト: `pnpm --filter worker test`(vitest、209 files)、型: `pnpm --filter worker typecheck`、デプロイ前: `wrangler deploy --dry-run`。

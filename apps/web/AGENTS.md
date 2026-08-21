# apps/web — 薬局スタッフ管理画面 / 全体管理者画面 (Next.js, Cloudflare Pages)

ルートの `AGENTS.md` の規約(日本語・custom/pharmacy seam・PHI-free・human gate)が優先。

## 地図

| パス | 役割 | 触るとき |
|---|---|---|
| `src/app/<route>/page.tsx` | ページの薄いエントリ。薬局ページは `src/custom/pharmacy/**` のコンポーネントを呼ぶだけ | 新ページ追加時のみ |
| `src/app/platform-admin/**` | 全体管理者画面(別認証・別セッション、`layout.tsx` にスコープバナー) | 運営者向け機能 |
| `src/app/login/page.tsx` | テナント職員ログイン(`?reason=expired&next=` を表示。`next` は `lib/safe-next-path.ts` で同一オリジン相対パスのみ) | 認証 UI |
| `src/custom/pharmacy/<feature>/` | **薬局機能の本体**(prescriptions / myna / intake / continuity / medication-followup / emergency-contraception / growth-loop(=薬局統計・機能設定・本日の業務) / rich-menu / platform-admin / privacy-policy / data-subject-requests / public-profile / print / provisioning / activity-notifications) | 薬局機能の変更はここ |
| `src/custom/pharmacy/api.ts` | 薬局 API クライアント(`/api/custom/pharmacy/*`) | エンドポイント追加時 |
| `src/custom/pharmacy/intake/labels.ts` | 問診ラベルの共有定義(テナント画面と platform-admin で共用) | ラベル文言 |
| `src/components/layout/sidebar.tsx` | サイドバー。薬局モードでは「本日の業務 / 患者対応 / 設定 / コンプライアンス」にグループ化。`// custom:pharmacy-*` コメントが薬局項目 | ナビ変更 |
| `src/components/auth-guard.tsx`, `src/lib/api.ts` | セッション切れ → `/login` へリダイレクト | 認証挙動 |
| `src/components/<generic>/`, `src/app/<generic>/` | フォーク元の汎用 CRM 画面(friends / broadcasts / scenarios …)。薬局モードではサーバー側で fail-closed | 基本的に触らない |
| `src/lib/platform-admin-api.ts`, `platform-admin-labels.ts` | 全体管理者 API とラベル | 運営者向け |

## ルール

- 表示文字列は日本語。開発者用語(READY/BLOCKED、Human Gate など)は `readinessStatusLabel()` 等で日本語化してから表示する。「処方せん」表記(「電子処方箋」は例外)。
- 権限判定は画面で行わない。API の 401/403 をそのまま扱う。
- 不可逆操作(取消・緊急停止・正式確認)は確認ダイアログ + `mutatingId` で二重送信防止。
- テスト: `pnpm --filter web test`(vitest, `*.test.ts(x)`)、型: `pnpm --filter web exec tsc --noEmit`。

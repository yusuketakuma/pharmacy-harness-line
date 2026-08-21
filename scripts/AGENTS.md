# scripts — 運用・検証スクリプト

| パス | 役割 | 注意 |
|---|---|---|
| `custom/pharmacy/setup-tenant.ts` | 薬局(tenant)の作成 | `pnpm tenant:setup` |
| `custom/pharmacy/bootstrap-tenant-admin.ts` | テナント管理者の初回作成(仮パスワードはランダム生成) | `pnpm tenant:admin-bootstrap` |
| `custom/pharmacy/bootstrap-platform-admin.ts` | 全体管理者の初回作成(未初期化環境のみ) | `pnpm platform:admin-bootstrap` |
| `custom/pharmacy/manage-tenant-settings.ts` | テナント設定の確認・変更 CLI(dry-run 既定、`--preflight`) | `pnpm tenant:settings` |
| `custom/pharmacy/migrate-line-credentials.ts` | LINE 資格情報の専用ストアへの移行 | 出力に秘密情報を含めない |
| `custom/pharmacy/generate-rich-menu-catalog.ts` | リッチメニュー素材カタログ(ドラフトのみ) | LINE への登録は人間の明示操作 |
| `check-migrations.ts` | マイグレーション整合性検証 | CI (`pnpm verify:ci`) で実行 |
| `version-contract.test.ts` | 全 runtime package の version 一致を検証 | リリース時に全 package + CHANGELOG を同時更新 |
| `release/` | リリース bundle / manifest 生成 | フォーク元由来 |
| `deploy/` | デプロイ補助 | 本番反映は人間ゲート |

すべてのスクリプトは `*.test.ts` を対で持つ(`pnpm test:scripts`)。本番 D1 / LINE に対する変更は明示フラグ + 確認なしに実行しない。

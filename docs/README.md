# docs/ の歩き方

このリポジトリは汎用 LINE CRM「LINE Harness」(upstream: `Shudesu/line-harness-oss`) を
薬局向けにフォークしたものです。

コードベースの構造・機能別リファレンス (アーキテクチャ、画面、API、ドメイン用語) は
Devin Cloud が生成する wiki を参照してください。`AGENTS.md` の「Devin Wiki」節にある
`.devin/wiki.md` からたどれます。リポジトリ内の `docs/` には、wiki では代替できない
**正本となる契約・監査証跡・人向けの運用文書**だけを残しています。

| フォルダ | 内容 |
| --- | --- |
| `docs/pharmacy/` | このフォーク固有の契約・運用・監査文書 (下表) |
| `docs/assets/` | README 用の図版・スクリーンショット |

## docs/pharmacy/ の文書

### コードから参照される契約文書 (削除・変更時はコードも確認)

| 文書 | 目的 |
| --- | --- |
| [IMPLEMENTATION_PLAN.md](pharmacy/IMPLEMENTATION_PLAN.md) | 不変条件、custom seam、中央デプロイ契約。拡張時は最初に読む |
| [MULTITENANT_OWNERSHIP_MATRIX.md](pharmacy/MULTITENANT_OWNERSHIP_MATRIX.md) | テーブルごとのテナント所有関係と認可境界 |
| [EC_PREVISIT_FORM.md](pharmacy/EC_PREVISIT_FORM.md) | 緊急避妊薬の事前確認フォーム仕様 (worker のコメントが § 番号で参照) |
| [RETENTION_MATRIX.md](pharmacy/RETENTION_MATRIX.md) | PHI の保持期間と purge 対象 |
| [FIELD_LEVEL_ENCRYPTION_DESIGN.md](pharmacy/FIELD_LEVEL_ENCRYPTION_DESIGN.md) | フィールド単位暗号化の設計 (`packages/AGENTS.md` の規約元) |
| [ADMIN-AUTH.md](pharmacy/ADMIN-AUTH.md) | 管理画面のテナント認証 (セッション Cookie + CSRF) |
| [MYNA_LAUNCH_URL.md](pharmacy/MYNA_LAUNCH_URL.md) | Myna 起動 URL (`/r/myna/:token`) の公開 URL 契約 |
| [PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md](pharmacy/PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md) | 印刷・活動通知の仕様 |

### 運用文書・マニュアル

| 文書 | 目的 |
| --- | --- |
| [OPERATION_GUIDE.md](pharmacy/OPERATION_GUIDE.md) | 薬局の日常運用ガイド (1 日の業務の回し方) |
| [CUSTOMER_DELIVERY.md](pharmacy/CUSTOMER_DELIVERY.md) | 薬局テナントの導入手順 |
| [customer-production-update-checklist.md](pharmacy/customer-production-update-checklist.md) | 本番更新チェックリスト |
| [WRONG_BINDING_RECOVERY.md](pharmacy/WRONG_BINDING_RECOVERY.md) | 誤った LINE 紐付けの停止・再登録手順 |
| [BETA_PARTICIPATION.md](pharmacy/BETA_PARTICIPATION.md) | ベータ参加の運用境界 |
| [manual-staff.md](pharmacy/manual-staff.md) / [manual-patient.md](pharmacy/manual-patient.md) | スタッフ向け / 患者向けの 1 枚マニュアル |
| [rich-menu-update-review.md](pharmacy/rich-menu-update-review.md) | リッチメニュー更新のレビュー記録 |

### 監査証跡

| 文書 | 目的 |
| --- | --- |
| [SECURITY_REVIEW_EVIDENCE_2026-08-19.md](pharmacy/SECURITY_REVIEW_EVIDENCE_2026-08-19.md) | セキュリティレビューの証跡 |
| [evidence/](pharmacy/evidence) | リリースごとの検証マニフェスト (JSON) |

## 新しい文書を追加するとき

1. 契約・運用・監査の文書なら `docs/pharmacy/` に置く。コードの説明だけなら文書を追加せず、wiki とコードコメントに任せる。
2. 先頭に目的と Status (日付) を 1〜2 行で書く。
3. 上の表または `README.md` のドキュメント節からリンクする。
4. PHI・シークレット・本番データは文書に含めない。

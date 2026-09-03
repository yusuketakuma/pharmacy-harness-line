# docs/ の歩き方

このリポジトリは汎用 LINE CRM「LINE Harness」(upstream: `Shudesu/line-harness-oss`) を
薬局向けにフォークしたものです。ドキュメントは出自ごとに 2 つのフォルダに分かれています。

| フォルダ | 内容 | 信頼度 |
| --- | --- | --- |
| `docs/pharmacy/` | このフォーク固有の設計・運用・監査文書。マルチテナント、PHI、Growth Loop など | **このフォークの正本** |
| `docs/upstream/` | フォーク元から継承した汎用 CRM 機能の文書 (wiki / manual / marketing / OSS 運用ルール) | 参考情報。フォーク後の変更が反映されておらず古い場合がある |
| `docs/assets/` | README 用の図版・スクリーンショット | — |

エージェントはまず `docs/pharmacy/` を読み、汎用機能 (配信・タグ・リッチメニュー・MCP など) の
仕組みを知りたいときだけ `docs/upstream/` を参照してください。両者が食い違う場合は
`docs/pharmacy/` とコードが優先です。

## docs/pharmacy/ の主要文書

| 文書 | 目的 |
| --- | --- |
| [IMPLEMENTATION_PLAN.md](pharmacy/IMPLEMENTATION_PLAN.md) | 不変条件、custom seam、中央デプロイ契約。最初に読む |
| [MULTITENANT_OWNERSHIP_MATRIX.md](pharmacy/MULTITENANT_OWNERSHIP_MATRIX.md) | テーブルごとのテナント所有関係と認可境界 |
| [RETENTION_MATRIX.md](pharmacy/RETENTION_MATRIX.md) | PHI の保持期間と purge 対象 |
| [FIELD_LEVEL_ENCRYPTION_DESIGN.md](pharmacy/FIELD_LEVEL_ENCRYPTION_DESIGN.md) | フィールド単位暗号化の設計 |
| [SECURITY_REVIEW_EVIDENCE_2026-08-19.md](pharmacy/SECURITY_REVIEW_EVIDENCE_2026-08-19.md) | セキュリティレビューの証跡 |
| [ADMIN-AUTH.md](pharmacy/ADMIN-AUTH.md) | 管理画面のテナント認証 (セッション Cookie + CSRF) |
| [CUSTOMER_DELIVERY.md](pharmacy/CUSTOMER_DELIVERY.md) | 薬局テナントの導入手順 |
| [customer-production-update-checklist.md](pharmacy/customer-production-update-checklist.md) | 本番更新チェックリスト |
| [manual-staff.md](pharmacy/manual-staff.md) / [manual-patient.md](pharmacy/manual-patient.md) | スタッフ向け / 患者向けの 1 枚マニュアル |
| [WRONG_BINDING_RECOVERY.md](pharmacy/WRONG_BINDING_RECOVERY.md) | 患者とLINE利用者を誤って紐付けた場合の停止・再登録手順 |
| [GROWTH_LOOP_ROADMAP.md](pharmacy/GROWTH_LOOP_ROADMAP.md) / [GROWTH_LOOP_KPI_CONTRACT.md](pharmacy/GROWTH_LOOP_KPI_CONTRACT.md) | 薬局統計 (Growth Loop) の拡張計画と KPI 定義 |
| [PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md](pharmacy/PHARMACY_PRINT_AND_ACTIVITY_NOTIFICATIONS.md) | 印刷・活動通知の仕様 |
| [rich-menu-update-review.md](pharmacy/rich-menu-update-review.md) | リッチメニュー更新のレビュー記録 |

## docs/upstream/ の構成

- `wiki/` — 機能別リファレンス (Home.md が目次)
- `manual/` — 運用マニュアル (README.md が目次)
- `marketing/` — リリース告知文
- ルート直下 — フォーク運用 (`FORK_CLOUDFLARE_WORKFLOW.md`)、OSS 同期ルール (`OSS-SYNC-CHARTER.md`,
  `OSS-SANDBOX-MERGE-GATE.md`)、LINE API プロキシ (`LINE-API-PROXY.md`)、installer sandbox、広告 CV 仕様

## 新しい文書を追加するとき

1. このフォーク固有の内容なら `docs/pharmacy/`、upstream から取り込んだ文書なら `docs/upstream/` に置く。
2. 先頭に目的と Status (日付) を 1〜2 行で書く。
3. 上の表または `README.md` のドキュメント節からリンクする。
4. PHI・シークレット・本番データは文書に含めない。

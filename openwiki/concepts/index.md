# ファイル

- [データベースと migration](database-and-migrations.md) - packages/db のスキーマ・migration の番号体系(baseline と custom_NNN)、bootstrap.sql の生成、クエリヘルパー、テスト用 SQLite アダプタ、追加のみの更新方針を説明する。
- [薬局 custom 境界と非破壊更新ルール](pharmacy-custom-boundary.md) - フォーク元の generic 機能と薬局固有機能を分ける custom/pharmacy seam、薬局モードの判定と fail-closed の考え方、機能(capability)の仕組み、非破壊・後方互換で更新するというプロジェクトルールを説明する。
- [プライバシー・暗号化・保持と削除](privacy-and-retention.md) - 問診の項目暗号化(AES-256-GCM の envelope)、PHI を出さない構造化ログ、3 年一律の保持と legal hold、データ主体請求(DSR)、承認と fence を必須とする recovery 経由の削除、開発済みと本番未実施の区別を説明する。
- [テナントスコープと認証・認可](tenant-scope-and-auth.md) - 薬局管理画面のテナント別パスワードセッション(Cookie + CSRF)、ログイン試行の throttle、連携用 Bearer、platform admin の別系統セッションとサポート権限、LIFF の ID トークン検証、line_account_id による認可の原則を説明する。

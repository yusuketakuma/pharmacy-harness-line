# ファイル

- [リリースとデプロイ](release-and-deploy.md) - バージョンの識別子(パッケージ版・ソースタグ・pharmacy-v* 販売者リリース)の区別、GitHub Actions による Cloudflare デプロイの段階と安全確認、中央本番更新チェックリスト、CHANGELOG と PLANS の役割を説明する。
- [テナント作成と運用スクリプト](tenant-provisioning.md) - 薬局テナントを作成する API と pnpm スクリプト(setup・platform admin・LINE 資格情報の移行・設定管理)、LINE 資格情報の暗号化保管、設定診断(configuration doctor)と readiness の判定を説明する。
- [テストと検証](testing-and-verification.md) - vitest の構成とテストの置き場所、代表的なテストの種類(テナント越境、ログの privacy、UI ルール、migration の追加のみ検査)、Biome、CI で使う検証コマンド(verify:ci)を説明する。

---
type: operations
title: リリースとデプロイ
description: バージョンの識別子(パッケージ版・ソースタグ・pharmacy-v* 販売者リリース)の区別、GitHub Actions による Cloudflare デプロイの段階と安全確認、中央本番更新チェックリスト、CHANGELOG と PLANS の役割を説明する。
tags: [release, deploy, github-actions, cloudflare, migrations, rollback]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-842af4a2b5a777a1d5eaf09e
    resource: repo://.github/workflows/deploy-cloudflare.yml
  - id: openwiki-source-4d1d392666be6dfdd7a91a2e
    resource: repo://.github/workflows/release.yml
  - id: openwiki-source-62c95097fe8889b67b2efd6a
    resource: repo://apps/worker/src/_version.ts
  - id: openwiki-source-d2bf4b2ba311a739b79ff485
    resource: repo://apps/worker/src/release-config.test.ts
  - id: openwiki-source-ca6cb4b1a14fd7969dfae3ec
    resource: repo://CHANGELOG.md
  - id: openwiki-source-afccbd1d84a1fdf2f1e6ca98
    resource: repo://docs/pharmacy/customer-production-update-checklist.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# リリースとデプロイ

## 識別子を混ぜない

リリースには別々の識別子があり、片方から他方を推測しません(`CLAUDE.md`)。

| 識別子 | 例 | 意味 |
| --- | --- | --- |
| パッケージ / ソース版 | `0.36.4`(`sdk`・`mcp-server` など) | コードの版。`CHANGELOG.md` の見出し `Pharmacy v0.36.4` はこれを確定させたもの |
| ソースタグ | `v0.36.4` | ソースの Git タグ |
| 販売者向けリリース | `pharmacy-v0.36.x` | 販売者向けの配布単位。ソースタグとは別 |

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
CHANGELOG の各エントリは、「エントリの作成だけでは `main` への反映、本番配備、薬局アカウントへの beta 適用、実患者データの操作、実際の LINE 送信を行わない」と冒頭で断っています。ローカルのコード、テスト成功、リリースメタデータ、デプロイ証跡、本番運用は別々の主張で、本番完了は必要なゲートを通ってからでなければ主張しません(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

`apps/worker/src/_version.ts` は `scripts/inject-version.ts` が生成するファイルで、リポジトリにあるのは開発用のスタブ(`BUNDLE_VERSION = '0.0.0-dev'` と全 0 のハッシュ)です。デプロイ時に実際の版・ハッシュ・`RELEASED_AT` を注入して Worker を再ビルドします。

## 文書の役割

- `CHANGELOG.md`: リリース履歴。各版の差分、後方互換の判断、実施した検証、残っている Human Gate を書きます。
- `PLANS.md`: タスク台帳。進行中の監査・メンテナンスの範囲、不変条件、検証、状態を書きます。
- `docs/pharmacy/`: 契約・運用・監査の正本文書。

## GitHub Actions

| ワークフロー | 目的 |
| --- | --- |
| `repository-verify.yml` | 秘密情報スキャン、CodeQL、依存関係とライセンスの基準、SBOM、`pnpm verify:ci`、主要アプリのビルド、LIFF と管理画面のブラウザ E2E、合成の保証成果物と来歴の証明 |
| `release.yml` | `v*.*.*` と `pharmacy-v*.*.*` のタグで起動。タグの指すコミットが実際のソースと一致することを確認し、migration 検査・スクリプトテスト・共有パッケージのビルド・型検査・テスト・各アプリのビルドを通してから GitHub Release を作ります(配備はしません) |
| `deploy-cloudflare.yml` | 共有の薬局用 Cloudflare 環境への配備 |
| `update-from-upstream.yml`、`openwiki-update.yml`、`deploy-pages.yml` | 上流の定期取り込み、OpenWiki の定期更新、`gh-pages` ブランチの GitHub Pages 配備(アプリの Cloudflare Pages 配備とは別) |

### `deploy-cloudflare.yml` の安全条件

トリガーは `dev` ブランチへの push(対象パスを限定)と手動実行(`workflow_dispatch`)です。ジョブの実行条件は、上流リポジトリではないこと、変数 `LINE_HARNESS_CLOUDFLARE_DEPLOY == 'true'`、そして `dev`、または `main` かつ手動実行です。同じ ref の実行は `cancel-in-progress: false` で直列化します。

`main`(本番)では次を要求します。

1. チェックアウトしたコミットがイベントの SHA と一致する。
2. 手動入力 `production_source_sha` が `GITHUB_SHA` と一致する(明示的な本番承認)。
3. `DEPLOY_TARGET` が環境(`production` または `development`)と一致する。
4. 必須の設定・secret 名を検証する(値は出力しない)。

その後の段階は次の順です。Worker と LIFF のビルド → 管理画面のビルド → 実行時リリースメタデータの注入と Worker の再ビルド → 最終成果物のハッシュ → **`scripts/check-migrations.ts` による追加のみの migration 検査** → wrangler 設定のパッチ → 共有 Worker の secret 確認 → **顧客設定の保護(`customer-config.ts prepare`)** → 移行前のリリース状態と D1 bookmark の記録 → 未適用の D1 migration の適用 → 薬局リッチメニューのカタログ公開(変更時のみ) → Worker の配備 → 健全性と配備版の確認 → **顧客設定が保持されたことの確認** → LIFF と管理画面(Pages)の配備と健全性確認 → 配備後のリリース状態の取得と証跡の記録。

Worker を先に更新し、Admin/LIFF は後に更新します。migration は単一の書き手として適用し、Worker が先に新しくなっても旧 Admin/LIFF が動く互換範囲を保ちます。Worker のビルド設定は `apps/worker/src/release-config.test.ts` が固定しています(`build:production` は `CLOUDFLARE_ENV=production`、配備は `--keep-vars` で本番の変数を保持、本番の D1 とバケット名が開発用と混ざらない)。

## 中央本番更新チェックリスト

`docs/pharmacy/customer-production-update-checklist.md` は、顧客別リポジトリでの更新が廃止され単一の Cloudflare 環境になったことを前提に、全テナントの設定とデータを保持するための確認項目です。

- **更新前**: 対象コミット・版・migration の確定、D1 の bookmark とロールバック手順、binding 先の一致、テナント数・アカウント対応数・メンバーシップ数の記録、孤立アカウントと重複対応が 0、追加のみの migration(既存の `custom_NNN` を編集しない)、破壊的変更なし、変更した契約ごとの直前版との後方互換テストが緑、旧 Admin/LIFF と新 Worker の混在の検証、越境(テナント・アカウント・友だち)の否定テストが緑。
- **更新中**: migration を単一の書き手で適用、Worker 先行、expand/dual-read/dual-write/default/fallback のみ、再実行しても migration と通知が重複しない、顧客別の workflow・Cloudflare 配備・管理画面 self-update は使わない。
- **更新後**: 件数が意図せず減っていない、既存テナントでログインでき別テナントコードは拒否、アカウント一覧が越境しない、署名付き webhook・LIFF 導線・処方箋画像の private read が動く、R2 の既存オブジェクトが残り新規キーがテナント配下に作られる、cron が有効なテナントのアカウントだけを処理し通知が重複しない、PHI と secret を含まない smoke 証跡を保存。
- **中止・ロールバック条件**: 件数の予期しない変化、越境の読み書きの成功、テナントの誤解決、暗号化対応 Worker 上で復元を完了しないまま旧 Worker へ戻す場合、R2 画像の公開化や別テナント参照、migration の checksum 不一致・再適用失敗・通知重複、直前版の契約が新版で動かない、破壊的変更や同時切替への依存の検出。

<!-- openwiki: broken internal link [/openwiki/architecture/shared-packages.md] link "/openwiki/architecture/shared-packages.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`update-engine`(管理画面からの自己更新)は、この中央運用では使いません(→ [共有パッケージ](/openwiki/architecture/shared-packages.md))。検証の中身は [テストと検証](/openwiki/operations/testing-and-verification.md) を参照してください。

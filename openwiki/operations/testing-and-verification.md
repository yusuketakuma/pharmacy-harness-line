---
type: operations
title: テストと検証
description: vitest の構成とテストの置き場所、代表的なテストの種類(テナント越境、ログの privacy、UI ルール、migration の追加のみ検査)、Biome、CI で使う検証コマンド(verify:ci)を説明する。
tags: [testing, vitest, biome, ci, migrations, playwright]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-2f9b79ed8a928bcc42d0c24e
    resource: repo://apps/liff/src/custom/pharmacy/v036-ui-rules.test.ts
  - id: openwiki-source-543152bef576015081112237
    resource: repo://apps/web/src/app/ui-safety.test.ts
  - id: openwiki-source-0fb57a8a6236aa9ba37f6f3e
    resource: repo://apps/worker/src/custom/pharmacy/test-sqlite.ts
  - id: openwiki-source-a7a13012fb1ed6daea578d5a
    resource: repo://apps/worker/vitest.config.ts
  - id: openwiki-source-59f729b67c0a733dbed55b7f
    resource: repo://biome.json
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-054704fc9917d82b70c81b08
    resource: repo://scripts/check-migrations.ts
  - id: openwiki-source-b58f839a189d87a7e1f37d39
    resource: repo://vitest.config.mts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# テストと検証

このリポジトリのテストは、機能の動作確認に加えて、**プロジェクトの規則をコードとして守らせる**役割を持ちます。テナント越境の否定、PHI がログに出ないこと、患者向け UI の可読性、migration が追加のみであることは、いずれも自動テストや静的検査で固定されています。

## 実行コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm verify:ci` | `format:check` → 共有パッケージのビルド → `pnpm -r typecheck` → `pnpm -r test` → `pnpm test:scripts` → `scripts/check-migrations.ts` |
| `pnpm test:scripts` | ルートの vitest。`scripts/**/*.test.ts` だけを対象(タイムアウト 30 秒。実際の git リポジトリを一時ディレクトリで動かすテストがあるため) |
| `pnpm -r test` | 各パッケージ・アプリの `vitest run` |
| `pnpm --filter liff test:e2e` / `pnpm --filter web test:e2e` | Playwright によるブラウザ E2E |
| `pnpm format` / `format:check` / `lint` / `check` | Biome(`@biomejs/biome`)。行幅 120、スペース 2、LF |

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`verify:ci` が CI の中心で、`repository-verify.yml` がこれに加えて秘密情報スキャン・CodeQL・依存関係とライセンスの基準・SBOM・LIFF と管理画面のブラウザ E2E を実行します。`release.yml` も同様の型検査・テスト・ビルドを通してからリリースを作ります(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。

## テストの配置

テストは対象の隣に置きます(`foo.ts` と `foo.test.ts`)。

- `apps/worker/src/**`: vitest(node 環境)。`@line-crm/line-sdk` はビルド前でも動くよう、`vitest.config.ts` の alias で TypeScript ソースを直接指します。
- `apps/liff`、`apps/web`: 各アプリの vitest。UI の部品テストとソース走査テストが中心です。
- `packages/db/test`: migration ごとの検証(`NNN_*.test.ts`)、bootstrap 生成器、`*-tenant-scope.test.ts` など。
- `scripts/**`: リリース・配備・CLI のテスト(`version-contract.test.ts`、`multitenant-client-update-retirement.test.ts` など)。

## DB を使うテスト

<!-- openwiki: broken internal link [/openwiki/concepts/database-and-migrations.md] link "/openwiki/concepts/database-and-migrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Worker のテストは、モックではなくインメモリの SQLite に実スキーマを流して検証できます。`custom/pharmacy/test-sqlite.ts` が `better-sqlite3` を `packages/db` のパスから解決し(pnpm は devDependency を Worker へ巻き上げないため、この 1 か所に集約)、`d1FromSqlite` で `D1Database` 互換のアダプタにします。`batch()` は実トランザクションで、失敗すると全体をロールバックします(→ [データベースと migration](/openwiki/concepts/database-and-migrations.md))。ルート単位のテスト(例: `friends-tenant-scope.test.ts`)は、逆に `@line-crm/db` をモックして Hono アプリへ直接リクエストを送り、ガードの挙動だけを確かめます。

## 規則を守らせるテスト

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **テナント越境の否定**: `*-tenant-scope.test.ts`、`chats-tenant-pair.test.ts`、`broadcasts-tenant-boundary.test.ts`、`liff-pharmacy-oauth-boundary.test.ts` など。別テナント・別アカウント・別の友だちの資源を指定すると拒否されることを確認します(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。
<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **薬局モードの遮断**: `webhook-pharmacy-mode.test.ts`、`broadcast-pharmacy-mode.test.ts`、`reminder-delivery-pharmacy-mode.test.ts`、`traffic-pools-pharmacy-mode.test.ts` など。薬局アカウントで generic 機能が動かないことを固定します(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。
<!-- openwiki: broken internal link [/openwiki/concepts/privacy-and-retention.md] link "/openwiki/concepts/privacy-and-retention.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- **ログの privacy**: `logging-privacy.test.ts` が Worker のソース全体を走査し、`console.*` に LINE ユーザー ID・患者 ID・トークン・回答を渡す書き方を失敗にします(→ [プライバシー・暗号化・保持と削除](/openwiki/concepts/privacy-and-retention.md))。
- **旧版との互換**: LIFF の `v032-contract.test.ts` など、`pharmacyMainMenuItems` や各ページのソースを読み、以前の契約が維持されていることを確認します。互換の焦点テストが無い契約変更はリリースできない、というルールに対応します。
- **患者向け UI のルール**: LIFF の `v036-ui-rules.test.ts` は、本文が `text-base` 以上であること、ボタン・リンク・select がタップ領域 44px(`min-h-11` または `pharmacy-control`)を保つことを、薬局の seam 配下の全 `.tsx` を走査して検査します。許可する小さい文字(必須バッジ、ヘッダの名前、更新時刻など)は明示の許可リストにあります。管理画面の `ui-safety.test.ts` も、ヘルスチェックの失敗を正常と表示しないこと、フィルタとラベルの関連付けなど、画面横断の安全性をソースで確認します。
- **migration の追加のみ**: `scripts/check-migrations.ts` が `DROP TABLE`・`DROP COLUMN`・`ALTER COLUMN ... TYPE`・テーブルやカラムの改名・DEFAULT なしの `ADD COLUMN ... NOT NULL`・`ADD UNIQUE` を静的に禁止します。許可されるのは `CREATE TABLE`、NULL 可または DEFAULT 付きの `ADD COLUMN`、`CREATE [UNIQUE] INDEX`、シード用 `INSERT` です。方針の適用開始番号より前の古い migration は対象外です(CI とデプロイの両方で実行)。
- **配備設定**: `release-config.test.ts` が本番の build/deploy スクリプトと D1・バケット名を固定します。

## 検証の使い方

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
変更の影響に合わせて範囲を選びます。局所的な変更は該当ファイルの vitest だけで足り、共有契約(認可、永続化、migration、後方互換)に触れる変更は、関連する越境テスト・互換テスト・`check-migrations` まで広げます。ローカルでのテスト成功は、リリースや本番運用が完了した証拠にはなりません(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。

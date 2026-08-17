# 顧客別 本番更新チェックリスト

顧客の `main` を更新してCloudflareへデプロイする前後に、顧客ごと・環境ごとに
このチェックリストを1部作成する。チェック記録には秘密情報、患者情報、処方情報、
LINEユーザーID、アクセストークンを記載しない。

## 0. 更新記録

| 項目 | 記入値 |
| --- | --- |
| 顧客名・顧客リポジトリ |  |
| 環境 | `development` / `production` |
| 更新PR |  |
| 販売元リリースタグ | 例: `pharmacy-vX.Y.Z` |
| 販売元コミットSHA |  |
| 顧客更新ブランチ | 例: `vendor/update-pharmacy-vX.Y.Z` |
| 作業日時（JST） |  |
| 実施者・承認者 |  |
| メンテナンス時間帯 |  |

## 1. 更新前チェック（Pre-flight）

### リリースとGitHub

- [ ] 更新元が設定済みの販売元リポジトリである。
- [ ] `release-manifest.json` のタグ、コミットSHA、migration一覧が更新PRと一致する。
- [ ] 顧客の `.line-harness-vendor.json` が現在の顧客 `main` と一致する。
- [ ] 更新PRのsecretlessテスト、build、migration安全性チェックが成功している。
- [ ] 顧客固有の変更と `custom/` 配下の変更に競合がない。
- [ ] `main` の保護ルール、承認者、Cloudflare Environment承認が有効である。
- [ ] `compatible-auto` を使わない更新、または自動マージ条件を満たしていることを確認した。

### D1（テナントデータ・個別設定）

- [ ] 顧客のD1 database名・database IDが対象Environmentの設定と一致する。
- [ ] `line_accounts`、`account_settings`、薬局テーブルなどの既存データを初期化しない更新である。
- [ ] 事前のD1 Time Travel bookmarkまたはデプロイ証跡IDを記録した。
- [ ] `_line_harness_migrations` のチェックサム台帳が存在する。
- [ ] 適用予定migrationが未適用分だけであり、既適用migrationの内容を変更していない。
- [ ] `DROP`、rename、既存データを壊す再構築を含むmigrationがない。
- [ ] `bootstrap.sql`を既存本番D1へ適用する手順になっていない。
- [ ] D1のバックアップ／復旧担当と連絡先が確認できる。

### R2（画像・ファイル）

- [ ] 顧客のR2 bucket名とWorkerの`IMAGES` bindingが一致する。
- [ ] 既存のリッチメニュー画像、処方せん画像などを別bucketへ切り替える変更がない。
- [ ] 代表的な非機密オブジェクトの存在確認を行った（キー名・件数のみ記録）。
- [ ] R2の保存期間、削除処理、容量に異常がない。
- [ ] R2のオブジェクト本文や患者情報をチェック記録へコピーしていない。

### Secrets・Cloudflare設定

- [ ] GitHub EnvironmentのSecrets名が揃っている（値は表示・転記しない）。
- [ ] GitHub EnvironmentのVariablesが対象顧客・対象環境を指している。
- [ ] `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`R2_BUCKET_NAME`、Worker名、Pages名が対象環境のものと一致する。
- [ ] `LINE_HARNESS_CLOUDFLARE_DEPLOY` の値とデプロイ対象（development / production）が一致する。
- [ ] シークレットの再発行・ローテーションが必要な変更では、旧値の失効手順を確認した。
- [ ] Secretsの値をPR、Issue、ログ、チェック記録に出していない。

確認するのは名前と設定状態だけにする。例:

```bash
gh secret list --repo CUSTOMER_OWNER/CUSTOMER_REPOSITORY --env production
gh variable list --repo CUSTOMER_OWNER/CUSTOMER_REPOSITORY --env production
```

### LINE設定

- [ ] Messaging API channel、LINE Login channel、Bot Basic IDが顧客のものと一致する。
- [ ] Webhook URLが対象Worker URLを指している。
- [ ] LIFF endpoint URLとデプロイ先が一致する。
- [ ] リッチメニューの既定表示、画像、画面切替先aliasを変更しない更新である。
- [ ] 顧客のテストLINEアカウントで確認できる担当者がいる。
- [ ] 本番ユーザーへテストメッセージを送らない手順になっている。

## 2. 更新実行チェック（Change window）

- [ ] 更新PRが顧客側で承認された。
- [ ] 更新直前のD1 bookmark、対象リリースSHA、対象Environmentを再確認した。
- [ ] `customer main` へのマージ後、`deploy-cloudflare.yml` が対象Environmentで起動した。
- [ ] build完了後に未適用D1 migrationが実行された。
- [ ] Worker、LIFF、Adminのデプロイ対象が同じコミットSHAである。
- [ ] migration失敗時はWorker／Pagesのデプロイを継続せず、承認者へ連絡した。
- [ ] 手動で本番D1へ`bootstrap.sql`や個別SQLを実行していない。

## 3. 更新後チェック（Post-flight）

### リリース・デプロイ証跡

- [ ] Workerのversion、Admin／LIFFのdeployment、顧客main SHAを記録した。
- [ ] D1 migrationの適用済み／スキップ結果とチェックサムを記録した。
- [ ] デプロイ後のWorker health checkが成功した。
- [ ] Adminトップと主要管理画面がHTTP 200で開く。
- [ ] Worker／Admin／LIFFが同じ顧客Environmentを参照している。
- [ ] `record-release-evidence.ts` による証跡が保存された。

### D1・R2の保持確認

- [ ] 既存のテナント一覧、個別設定、リッチメニュー定義が管理画面で表示される。
- [ ] 患者・友だち・受付データは件数または合成テストデータで確認し、実データを記録していない。
- [ ] 既存R2画像が管理画面または公開導線で表示できる。
- [ ] 更新前後でD1 database ID、R2 bucket、Worker bindingが変わっていない。
- [ ] 新migrationの列・テーブルを新コードが参照できる。

### Secrets・LINEの疎通確認

- [ ] Secretsの名前とEnvironment設定が更新前と一致する（値は比較・記録しない）。
- [ ] LINE Webhook検証または合成イベントが成功する。
- [ ] テストLINEアカウントでログイン、リッチメニュー表示、ページ切替を確認した。
- [ ] 薬局機能を更新した場合、処方せん事前送信・患者アンケートのテスト導線を確認した。
- [ ] テスト後に本番ユーザー、テスト用画像、テスト用メッセージが残っていない。

## 4. 即時停止条件

次のいずれかに該当したら、顧客への完了報告と自動マージを止める。

- D1 checksum mismatch、migration失敗、migration台帳欠落
- D1 database ID、R2 bucket、Worker／Pages Environmentの不一致
- 必須Secret／Variableの欠落、またはSecret値の漏えい
- Webhook、LIFF、管理画面のhealth check失敗
- 既存テナント設定、リッチメニュー画像、受付データが表示できない
- 顧客固有変更と販売元変更の競合を解消できていない
- LINEテストで別顧客のアカウント・URL・画像へ到達する

## 5. 完了記録

| 項目 | 記入値 |
| --- | --- |
| 更新後Worker version / SHA |  |
| Admin deployment ID |  |
| LIFF deployment / SHA |  |
| D1 bookmark / migration evidence ID |  |
| Smoke test結果 | `PASS` / `FAIL` |
| ロールバック要否 | `不要` / `要` |
| 顧客承認者 |  |
| 備考（秘密情報・患者情報を除く） |  |

完了記録は顧客リポジトリのIssue、デプロイ証跡、または契約で指定した保管場所へ保存する。
Secrets、LINEアクセストークン、患者情報、処方情報、画像本文は保存しない。

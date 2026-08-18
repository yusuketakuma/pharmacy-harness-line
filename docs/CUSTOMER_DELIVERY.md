# 薬局テナントの導入

Status: centralized multi-tenant topology, 2026-08-18.

顧客ごとのGitHubリポジトリ、Cloudflare環境、更新PRは使用しません。
全薬局は販売元が管理する1つのCloudflare環境へ接続し、D1とR2のデータは
`tenant_id`およびテナント配下のキーで論理分離します。

```text
platform repository
       |
       v
single Cloudflare Worker + D1 + R2 + Admin
       |
       +-- tenant A -- LINE account A -- staff A
       +-- tenant B -- LINE account B -- staff B
```

## 新規薬局の導入

1. platform ownerが一意の薬局コードでtenantを作成する。
2. LINE accountをtenantへ関連付ける。
3. staffをtenantへ所属させ、owner/admin/staffの役割を設定する。
4. 薬局ごとのLINE Channel、LIFF、Webhook設定を登録する。
5. synthetic userでログイン、LIFF、署名済みWebhook、R2画像参照を確認する。
6. cross-tenant否定テストを確認してから利用を開始する。

患者データ、LINE secrets、画像をGitHubや別の顧客環境へ複製してはいけません。

### CLIによる初期設定

共有Workerへ、用途の異なる3つのSecretを一度だけ登録します。各値は32 byte以上の
独立した乱数とし、互いに、またLINEの各SecretやAPI統合キーと兼用してはいけません。

```sh
npx wrangler secret put PLATFORM_ADMIN_KEY --name <shared-worker-name>
npx wrangler secret put CROSS_ACCOUNT_TOKEN_KEY --name <shared-worker-name>
npx wrangler secret put LINE_CREDENTIAL_KEY_V1 --name <shared-worker-name>
```

`LINE_CREDENTIAL_KEY_V1`はD1内のLINE資格情報を暗号化するルート鍵です。通常の
デプロイで再発行してはいけません。ローテーションは、全資格情報を新しい鍵で
再暗号化して読取確認する専用手順が完成し、責任者が承認した場合だけ行います。
デプロイworkflowは3つのSecret名がCloudflareに存在することだけを確認し、値の
上書きや自動ローテーションは行いません。

ローカル環境へ同じplatform keyと、対象薬局がLINE Developersで発行した値を
設定してから実行します。値をコマンド引数、Git、ログへ含めてはいけません。

```sh
export PHARMACY_PLATFORM_ADMIN_KEY='<platform key>'
export PHARMACY_LINE_CHANNEL_ACCESS_TOKEN='<Messaging API access token>'
export PHARMACY_LINE_CHANNEL_SECRET='<Messaging API channel secret>'
export PHARMACY_LINE_LOGIN_CHANNEL_SECRET='<LINE Login channel secret>'

pnpm tenant:setup -- \
  --worker-url https://<shared-worker-host> \
  --tenant-code example-pharmacy \
  --tenant-name 'Example Pharmacy' \
  --admin-id admin \
  --admin-name 'Owner' \
  --line-channel-id 2000000000 \
  --line-name 'Example Pharmacy LINE' \
  --line-login-channel-id 2000000001 \
  --liff-id 2000000001-AbCdEfGh
```

成功時だけ薬局コード、管理者ID、1回限りの仮パスワードを表示します。初回
ログインでは仮パスワード変更が必須です。旧APIキーによる管理画面ログインは
利用できません。SDK/MCP向けのテナント限定APIキーは外部連携専用であり、管理
画面へのログインには使用できません。

### 既存テナントの移行gate

旧APIキーによる管理画面ログインを廃止する前に、既存tenantへ最初のowner
ログインを1件だけ発行します。既存のLINE account、患者、処方せん、画像は変更
しません。同じ入力の通信再試行は同じ発行結果として扱い、2人目の初期ownerは
拒否します。

```sh
export PHARMACY_PLATFORM_ADMIN_KEY='<platform key>'
pnpm tenant:admin-bootstrap -- \
  --worker-url https://<shared-worker-host> \
  --tenant-id '<tenant-id>' \
  --admin-id admin \
  --admin-name 'Owner'
```

成功時だけ薬局コード、管理者ID、1回限りの仮パスワードを表示します。新方式で
ログインとパスワード変更を確認してから、以下のLINE資格情報移行へ進みます。

`custom_018`の適用だけでは、既存の`line_accounts`平文列は自動削除されません。
本番では次の順序を崩さず、各段階の証跡を確認します。

1. 3つの共有Worker Secretが別々の値で登録済みであることを確認する。
2. additive migrationを適用し、暗号化テーブルを作成する。
3. 対象tenant/accountの対応を確認して明示的なbackfillを実行する。
4. 管理画面の「LINE接続を確認・更新」を実行し、bot identityと共有Webhookを登録する。
5. 暗号化済み資格情報でWebhook受信・手動送信・リッチメニュー操作を確認する。
6. 全件一致を確認後に限り、旧平文列を非秘密のsentinelへ置換する。

```sh
export PHARMACY_PLATFORM_ADMIN_KEY='<platform key>'
pnpm tenant:line-credentials -- \
  --worker-url https://<shared-worker-host> \
  --tenant-id '<tenant-id>' \
  --line-account-id '<line-account-id>' \
  --phase backfill

# 暗号化済み資格情報による実動作を確認した後だけ実行する
pnpm tenant:line-credentials -- \
  --worker-url https://<shared-worker-host> \
  --tenant-id '<tenant-id>' \
  --line-account-id '<line-account-id>' \
  --phase scrub \
  --confirm-scrub
```

scrub後に旧Workerへ戻す場合は、暗号化対応Workerを動かしたまま先に平文列を復元します。
旧Workerを先に配信するとWebhook・送信・リッチメニュー操作が停止するため禁止です。

```sh
pnpm tenant:line-credentials -- \
  --worker-url https://<shared-worker-host> \
  --tenant-id '<tenant-id>' \
  --line-account-id '<line-account-id>' \
  --phase restore \
  --confirm-restore
```

復元後にWebhook受信とLINE送信を確認してから旧Workerへ戻します。rollbackを中止した
場合は、暗号化対応Workerへ戻した後に再度backfillの一致確認とscrubを行います。

読取時の自動backfillや、暗号化行が壊れた場合の平文fallbackは行いません。
未移行・破損・tenant不一致はfail closedとなります。

新規設定CLIはMessaging APIのアクセストークンを検証し、共有Webhook URLを自動設定
します。既存テナントのbackfill後は、上記の管理画面操作で同じ確認・設定を行います。
LINE LoginチャネルとLIFFアプリ自体の作成、LIFF Endpoint URLの登録、
Webhook利用の有効化はLINE Developersで確認するHuman gateです。

LIFF Endpoint URLは、CLIまたは管理画面が表示する専用LIFF Pages URL
（`https://<LIFF_ORIGIN>/?liffId=<テナントのLIFF ID>`）を登録します。共有Worker URLは
Webhook・API・OAuth callback用であり、LIFF Endpointへ登録してはいけません。登録先を
取り違えると、LINEから開いた画面が汎用Workerクライアントになり、処方せん受付を開けません。

## 更新

更新はplatformの`dev -> main`昇格後、中央Cloudflare環境へ1回だけ実施します。
顧客操作や顧客リポジトリへの同期はありません。migrationはadditiveに適用し、
既存tenant、staff membership、LINE account、D1データ、R2オブジェクトを保持します。

テナント管理者にはplatformコード、Cloudflare、migrationを更新する権限を与えません。
管理画面には読取専用のビルドバージョンだけを表示します。

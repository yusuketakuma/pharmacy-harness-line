# 顧客への初回納品

販売元の不変リリースを顧客PCへクローンした時点で、プログラム一式の
配信は完了します。その後、同じチェックアウトを顧客所有のGitHub、
Cloudflare、LINEへ接続します。販売元へ顧客の秘密情報を渡しません。

## 1. 空の顧客リポジトリを用意

顧客所有のGitHubアカウントで空のprivateリポジトリを作成します。
README、`.gitignore`、Licenseは追加しません。

## 2. 販売元の確定版を顧客PCへクローン

販売元から発行されたread-only tokenは環境変数または`gh auth login`
だけで使用し、clone URLへ埋め込みません。

```bash
mkdir release
GH_TOKEN="$SELLER_READ_TOKEN" gh release download \
  --repo SELLER_OWNER/line-harness-pharmacy \
  --pattern release-manifest.json \
  --dir release

TAG=$(node -e "const m=require('./release/release-manifest.json');const r=m.releases.find(x=>x.version===m.latest);process.stdout.write(r.customer_source_update.tag)")
GH_TOKEN="$SELLER_READ_TOKEN" gh repo clone \
  SELLER_OWNER/line-harness-pharmacy customer-checkout -- --branch "$TAG"
```

このclone完了時点で、顧客PCの`customer-checkout`にプログラムがあります。

## 3. 顧客checkoutへ変換

`CUSTOMER_REVIEWER`は顧客側で更新PRを承認するGitHub userまたはteamです。

```bash
cd customer-checkout
pnpm install --frozen-lockfile
pnpm tsx scripts/customer-onboarding/configure.ts \
  --checkout-dir "$PWD" \
  --seller-repository SELLER_OWNER/line-harness-pharmacy \
  --seller-url git@github.com:SELLER_OWNER/line-harness-pharmacy.git \
  --customer-url git@github.com:CUSTOMER_OWNER/CUSTOMER_REPOSITORY.git \
  --manifest ../release/release-manifest.json \
  --reviewer CUSTOMER_REVIEWER \
  --push true
```

結果は次の構成になります。

```text
origin  -> 顧客private repository（push先）
vendor  -> 販売元repository（fetch専用、pushはDISABLED）
main    -> 販売元タグを祖先に持つ顧客初期コミット
```

## 4. 顧客GitHubを保護

販売元read-only tokenはクリップボードからstdinで登録し、ファイルや
コマンド引数へ保存しません。

```bash
pbpaste | pnpm tsx scripts/customer-onboarding/github-settings.ts \
  --customer-repository CUSTOMER_OWNER/CUSTOMER_REPOSITORY \
  --seller-repository SELLER_OWNER/line-harness-pharmacy \
  --seller-token-stdin true
```

この時点ではCloudflare自動deployは`false`、更新方法は`manual`です。
`main`保護、CODEOWNERS承認、secretless更新ポリシー、developmentと
productionのGitHub Environmentsだけが有効になります。

## 5. 顧客Cloudflare/LINEへ初期deploy

既存セットアップを同じcheckoutから実行します。

```bash
pnpm --filter create-line-harness build
node packages/create-line-harness/dist/index.js setup \
  --repo-dir "$PWD" \
  --from-source
```

顧客所有のCloudflare、LINE、GitHub Environment設定と開発・本番の
合成データ確認が完了するまで、自動deployと互換auto-mergeを有効に
しません。確認後に顧客リポジトリで次を設定します。

```bash
gh variable set LINE_HARNESS_CLOUDFLARE_DEPLOY \
  --repo CUSTOMER_OWNER/CUSTOMER_REPOSITORY --body true
```

互換auto-mergeはさらにカナリア顧客で検証した後だけ、
`CUSTOMER_UPDATE_CANARY_PASSED=true`と
`CUSTOMER_UPDATE_MODE=compatible-auto`を設定します。DB、Worker、認証、
依存関係、設定、権限の変更はこの設定後も必ず手動承認です。

## 6. 顧客別の本番更新チェック

本番運用開始前と、顧客ごとの更新実施前後に、次のチェックリストを
必ず1部作成します。

[顧客別 本番更新チェックリスト](custom/pharmacy/customer-production-update-checklist.md)

このチェックはD1・R2・Secrets・LINE設定の保持確認を目的とします。値そのもの、
患者情報、処方情報、LINEユーザーID、アクセストークンはチェック記録へ保存しません。

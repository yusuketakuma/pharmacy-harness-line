# 中央本番更新・テナント保持チェックリスト

顧客別リポジトリ更新は廃止済みです。このチェックリストは、単一Cloudflare環境を
更新するときに全tenantの設定とデータを保持するために使用します。

## 更新前

- [ ] 対象commit、version、migration一覧を確定した。
- [ ] D1 bookmark/backupとrollback手順を記録した。
- [ ] D1、R2、Worker、Admin、LIFFのbinding先が現行本番と一致する。
- [ ] `WORKER_PUBLIC_URL`は実Worker、`ADMIN_PUBLIC_URL`/`ADMIN_ORIGIN`は実Admin、`LIFF_PUBLIC_URL`/`LIFF_ORIGIN`は同じ薬局LIFF Pagesを指す。
- [ ] Secretsの値を出力せず、必要なsecret名の存在だけを確認した。
- [ ] tenant数、active tenant数、LINE account mapping数、staff membership数を記録した。
- [ ] orphan LINE accountと重複tenant mappingが0件である。
- [ ] additive migrationであり、既存の`custom_NNN`を編集していない。
- [ ] production storageの削除・reset・再作成、schema/API field/routeの削除・rename・非互換な意味変更を含まない。
- [ ] 変更した永続化/API contractごとに、直前releaseとの後方互換テストがGreenである。
- [ ] 旧Admin/LIFF→新Workerと、新Admin/LIFF→旧Workerまたは安全なfallbackの混在期間を検証した。
- [ ] cross-tenant、cross-account、cross-friendの否定テストがGreenである。

## 更新中

- [ ] migrationを単一writerで適用した。
- [ ] Workerを先に更新し、Admin/LIFFとの互換範囲を維持した。
- [ ] expand/dual-read/dual-write/default/fallbackだけで移行し、全componentの同時切替を要求していない。
- [ ] 失敗時に再実行してもmigrationと通知が重複しない。
- [ ] 顧客別GitHub workflow、顧客別Cloudflare deploy、管理画面self-updateを実行していない。

## 更新後

- [ ] tenant、mapping、membershipの件数が意図せず減っていない。
- [ ] 既存tenantでログインでき、別tenantコードでは拒否される。
- [ ] 各tenantのLINE account一覧が越境せず表示される。
- [ ] signed webhook、LIFF患者導線、処方せん画像のprivate readが動作する。
- [ ] R2既存オブジェクトが保持され、新規キーがtenant配下へ作成される。
- [ ] cronがactive tenant accountだけを処理し、重複通知がない。
- [ ] PHIやsecretを含まないsmoke evidenceを保存した。

## 中止・rollback条件

- tenant/mapping/membership件数の予期しない変化
- cross-tenant read/write成功
- LINE account、LIFF、Webhookのtenant誤解決
- scrub後に旧Workerへ戻す場合、暗号化対応Worker上で`restore --confirm-restore`を完了していない
- R2画像の公開化または別tenant参照
- migration checksum不一致、再適用失敗、通知重複
- 直前releaseのclient/API/data contractが新releaseで動作しない
- 破壊的変更またはWorker/Admin/LIFFの同時切替依存を検出

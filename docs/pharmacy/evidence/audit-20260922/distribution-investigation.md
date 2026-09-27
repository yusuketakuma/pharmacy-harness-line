# 配布経路の限定調査受入記録

ID: AUDIT-DISTRIBUTION-20260922 / AUDIT-DISTRIBUTION-SUPPLEMENT-20260922
担当: /root/audit_db（既存thread再利用、read-only、再帰spawnなし）
入力P: 9b9825366b0cc04af85591b22257525579ce414a。補足調査はHEAD再取得なし、親のF06変更と同時期。対象bundle/manifest/source publisherには親変更なし。
変更path/commit/patch: なし。調査成果のみ。
適用: root/packages AGENTS、非破壊後方互換更新契約。
保持: 適用済migration不変、旧manifest/API互換、旧Workerと追加schemaの共存、検証前書込み禁止、利用者ファイル保護。
検証: 対象限定rg/cat/sed/gitによる静的確認のみ。テスト/build/CLI実行/外部接続/secret/実データなし。glob未一致の検索はdirectory検索へ修正。

## F-DIST-01（P1、確定した未検証経路、互換修復設計未完了）

bundle.ts ParsedBundleはmigrationを取得するがverifyBundleHashes/Integrityはworker/workerAssets/admin/liffのみ照合。CLI update.ts 798–825とengine index.ts 192–212は照合後applyD1Migrationsへ進む。migrationのchecksumは受信SQL自身から計算し、既存ledgerとの変更検出はあるが新規SQLの期待digest照合はない。他componentを保持してmigrationだけ変えると現在のcomponent integrity検証では区別しない。実攻撃・本番被害は未確認。

訂正: 初回報告でcustomer_source_update.migration_digestsをbundle期待digest根拠としたが、追加調査で母集団一致を確認できなかったため撤回。validatorはkeys==release.migrations、new_migrationsはsubset可であり、new_migrationsだけのdigestとも断定しない。

正式customer-production-update-checklistは顧客別repo更新廃止。現在release.ymlはsource releaseのみ、retirement.testがpublisherとbundle/manifest公開の不在を保証。残存build-bundle.tsは指定migration dir全体をコピーし、source metadataを参照しない。update-manifestはentry検証保存のみ。

候補: source fieldとは別のoptional top-level migrations_hash（canonical sorted path/NUL/bytes/NUL）またはbundle_sha256。新field存在時は形式・内容必須照合、旧reader/API保持。廃止workflowは復活しない。ただし追加fieldだけでは旧releaseの未検証SQLを保護できない。完全保護には信頼できる旧artifactからのmetadata補完等が必要。正本未確認。

同根: worker_assets_hash省略時も非空assetsはuploadされる。旧公開release実態未確認のため全面拒否の互換影響は不明。空assetsかつLIFF Pagesなしは拒否、別LIFF Pagesありなら既存assets保持。現在build-bundle CLIはassets dir必須。旧manifest+空assets+別LIFF Pages互換を明示して検証する必要。

## F-DIST-02（P2、確定、親F06で修復）

bundle routeEntryがadmin/../outsideを../outsideとして保持→materializeがkey保持→setup stageAdminFilesがjoinで外へ書込む。hashが一致する不正pathを含むbundleが条件。通常改ざんのhash回避ではない。CLI update writeLocalWorkerArtifactsにはabsolute/.. guardがあり、初期の当該writer疑いは撤回。symlink/hardlinkはparserで展開しない。

## 懸念

C-DIST-03(P2): parseBundleStreamの全entry Buffer蓄積に上限なし、不要bucketも分類前蓄積、bundle_size_bytesは表示用。資源枯渇実測なし。適切な上限未確認。
C-DIST-04(P3): clone-repo ensureRepo/pinRepoToTagでfrozen install失敗の理由を問わず通常installへfallback。固定tagでもlock/dependency変更の可能性、実変更の証拠なし。

## 確認済み保全・coverage

- bundle/manifest/materialize、phases preflight/apply/rollback、CLI index/release-bundle/clone-repo、package manifests/tsup: 全文静的読取り。
- migrations: splitter/ledger事前検証/pending構築までPARTIAL、後半実行/error未読。既存checksum変更/欠落ledger/v0.33非prefix ledger拒否を確認。
- engine index: snapshot/download/verify/apply/failure入口PARTIAL。
- update command: config/入口/bundle照合/migration呼出/local artifacts PARTIAL。
- setup command: 検索による経路特定のみ。deploy-admin: stage/deploy入口のみ（親は全文確認）。
- rollbackはD1を戻さずWorker version/Pages deploymentを戻す。旧snapshotはbundle URL fallback。
- setupはrelease version pinしresumeでlatestへ自動変更しない。
- trusted-ledgerはSQL+ledger同query、失敗時結果再確認を意図。実D1 atomicity未検証。
- manifest署名は経路に見当たらないが署名必須契約未確認のため不在だけを欠陥扱いしない。
- hooks/license収録/全CF adapters/生成配布物は子未検証。C07/C12/X01/X02全体PARTIAL。

必要検証: migration-only tamperの書込み前拒否、旧manifest/public signature互換、新digest一致/不一致/不正/欠落、assets省略互換、生成配布物のisolated import。旧未検証範囲は消さず明示。配布全体安全性PASSではない。


## DIST-FOLLOWUP-20260922-02

担当/root/audit_db、開始/終了HEAD af9a0822ef17f2f57557512c6fafabd0ea977b70。read-only、変更/patch/commitなし。親がbundle/types/manifest/build-bundle/release workflowを照合。

正式customer-production-update-checklistは顧客別repository更新を廃止し中央Cloudflare更新へ移行。release.ymlはbuild/test後にasset引数なしgh release createのみ。retirement.testはbundle/manifest publisherとWorker self-update mount/UIの非再導入を検査。README149行は汎用CLIをフォーク元のsetup用途と説明し、root deploy:setup/updateとexecutable/consumerが残る。汎用CLIを全面廃止する明示契約も、現在の配布SLAも未確認。F-DIST-01を現行中央releaseの改ざん経路とは扱わない。残存generic consumerの検証漏れとして維持、P1の運用到達条件は未確認。

consumerはengine index193–212、CLI update812–819、setup release-bundle102–109。共通verifyBundleHashes/Integrityはmigrationを照合しない。

最小候補はoptional ReleaseEntry.migrations_hashとcomputed hash追加。manifest.tsのcustomer_source_update早期return前に存在時sha256形式検査、bundle.tsでsorted path/NUL/bytes/NULを計算し存在時必須比較（empty/nullを省略扱いしない）。旧field/schema_version/旧signature保持。build-bundle.tsに同じ収録集合のmetadata出力入口を追加する必要がある。update-manifestは入力validator/writerであってpublisherではない。現在のscripts/releaseにrelease-entry producerが無く、新fieldだけでは供給が成立しない。廃止publisherを復活させない。customer_source_update.migration_digestsの母集団同一性は保証されず転用しない。

必要検証: 新hash一致、SQLのみ変更/追加/削除/改名の拒否、不正hashのsource無し拒否、旧manifest/optional assets互換、producer→tar parse→verify、全consumerの不一致時mutation無し、旧readerで新field読取り、retirement維持。旧releaseにhashがない部分は信頼元からmetadata補完するまで未保護。manifest+bundle双方の改変に対する署名保証ではない。

実行はgit rev-parse/対象cat/sed/rgのみ。誤pathをscripts/releaseへ訂正、一部長出力省略あり。tests/build/CLI/外部接続/実利用確認は未実施。未解決: 継続配布の責任主体と旧artifactの信頼できるdigest根拠。親は不完全なhash追加だけで修復済みとしない。

## DIST-FOLLOWUP 実行再現 (362737be415b11577535486a6d68f7d67edd728b)

primaryがactual tar-stream pack→gzip→parseBundleStream→verifyBundleHashes/Integrityを実行。worker/assets/admin/liffを同一にした2bundleを作り、migration SQLだけsynthetic_expected→synthetic_unexpectedへ変更。元bundleからcomputed manifestを作り、変更bundleを検証しても例外が出ない。期待reject回帰はexit1/1FAIL (distribution-migration-tamper-red.log/case.txt)。SQLはCREATE TABLEのみ、DB適用/外部アクセスなし、実改ざんの発生を主張しない。temp testはbyte保存照合後削除。現HEADでもF-DIST-01再現、製品変更なし。

verifyBundleIntegrityは現在もworker_bundle_hash欠落を拒否するがmigration hashは持たない。修復時の新metadataと旧配布物の信頼根拠が未確定な点は従前どおり。optional fieldだけで全面修復としない。過去の静的読取のみという制約を今回のcomponent検証入口について解消、全consumer write前拒否/公開旧manifest調査は未実施。migrations.ts後半の実行/reconciliationを追加読取: trusted pathはmigration SQL+ledger INSERTを単一executeへまとめ、エラー後checksum照会で結果を判別、legacy baselineは個別statementと既知schemaerror skip。remoteD1 atomicityの実証は今回行っていない。

旧artifact信頼元確認: コード既定の公開Shudesu/line-harness-oss latest manifestをwebで取得試行したがredirect取得失敗、公開GitHub releases/latest APIもweb取得不可。環境変数を除いた認証なしurllib公開API一回はHTTP403 rate limit。制限回避は行わず、信頼済み旧hash一覧/配布台帳の所在をuserへasync質問済み。これは修復の互換設計に必要な情報であり、外部書込み承認の要求ではない。回答未取得でも独立UI監査を継続。

## 信頼根拠の確認結果（ユーザー回答）
ユーザーは旧OSS bundle.tar.gzのmigration信頼済みハッシュ/配布台帳の参照先について「わからない」と回答。質問待ちではなく参照先不明として扱う。旧artifactの期待hashを推測せず、未検証をverifiedと扱わない。一律旧版拒否による互換破壊も行わない。F-DIST-01は未解決、全体完了/releaseの証拠には不足。他の独立監査/修復は継続。

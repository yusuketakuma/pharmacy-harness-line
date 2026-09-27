# F20 medication notification queue progress

PLANNED FIX/P1/CONFIRMED_BUG。P=fb6ab3452d047befd539c6c965187ab0f7425b70 primary/dev。根拠medication-queue-progress-case/log/result、51件全bootstrapSQLite/実list+processor/paused sender。目的: skipped/failed先頭が後続accountの試行を永久に妨げない。最大処理件数と送信直前の権限/停止条件、clinical status/version、provider retry keyを保持。

実装候補: 既存followupへ内部用notification_checked_atをadditive migrationで追加し、実際の選択処理時にaccount/id条件で記録。選択順を最終確認時刻（未確認はdue_at）へ変え、送信せずskipした行も後ろへ回す。schema検知で旧schemaは現行の読取/動作を維持、旧Workerは新columnを無視。clinical versionやdue_atを公平性用に書き換えない。LIMIT増加/無制限scan/通知cap緩和/停止中送信を修復扱いしない。最終方式はindex/consumer確認後決定。

想定scope: custom/pharmacy/medication-followup/repository.ts, notifications.ts, relevant tests、新custom_079 additive migration（次番号を実編集前再確認）、bootstrapはgenerate:bootstrapで再生成。公開API fields/routes/message/retry key不変、新query/mutationはaccount scope。

到達条件: 先頭50停止+後続1で有限次tickに後続選択、停止行は未送信、失敗/credential欠落でも進行、再開時に停止行も再選択、上限保全、同tick競合/old schema互換、旧Worker読取り/既存persisted値保全、必要DB migration/checks/型/統合/artifact。負荷評価は既存query対固定50/500/5000合成候補で比較し、無制限workを導入しない。

未実装、未検証、patch/commitなし。全Goalはactive、他coverageと最終独立レビューは未完。

## 実装中 checkpoint
RUNNING、未commit。027_custom_079_pharmacy_followup_notification_queue.sqlにnullable notification_checked_at + partial expression indexを追加。bootstrap/metaは既存generate:bootstrapで再生成（exit0）、historical migration差分なし。repositoryのschema検知で旧column無しは旧query/無markerを保持。新column有りは最終確認時刻順、processor先頭でaccount/id/version/active tenant mappingを条件に単調な確認時刻を記録。clinical version/status/due_atとprovider retry keyは不変。

F20-near.log: notification queue新3case（paused/failure/credential missing）+既存notification3/compatibility4=10PASS。先頭50の次tickに末尾別account1へ到達、件数50、全51clinical状態/version/due不変、FK検査空。sender/credentialはstub、実provider送信テストではない。F20-type.log typecheck exit0。

残必須: 新testの読みやすい整形、package migration対テスト（既存row保全/旧query互換）、schema旧新のmarker実証、再選択/同tick競合/誤account拒否、固定負荷比較、統合とartifact、P→W新規file込みpatch再現、最終diff/commit。これら未実施につきVERIFIED/INTEGRATEDとはしない。次ターンは当差分を継続し二重適用しない。

## 互換/更新scope追加確認
RUNNING、未commit。packages/db/test/custom_079_pharmacy_followup_notification_queue.test.ts追加。001–026を実ファイルから適用（既存generator同様、歴史的duplicate column/already existsのみ許容）して旧schemaに合成既存rowを作り、027適用後に新column以外の全値一致、旧UPDATEでclinical状態/版を更新可能、初期NULL、不正日時CHECK拒否、FK検査空、index存在をassert。F20-migration.log初回は歴史的重複columnでfixture構築失敗、generatorとの適用方法一致後F20-migration-final.log1PASS exit0。027自身の失敗はcatchしない。

notification-queue.testへ誤account/tenant/versionのmarker拒否、古いtickが最新時刻を戻さない、旧rowshapeは新columnへのDB queryをしない検証を追加。F20-queue-scope.log既存含む10PASS exit0。同時provider送信の実証ではなくqueue metadataの競合条件確認。git diff --check0。

未完: test整形、旧schema上で新list実行、停止行の再選択、固定負荷比較、統合/型再検証/artifact、完全patch再適用、最終diff/commit。今回製品ロジックは前ターンから不変、tests追加のみ。

負荷比較の事前条件: 50/500/5000件、旧schema/新schemaをそれぞれ同じ合成fixtureで作成、各3回processor実行、sender paused、actualSQLite/D1 adapter。最大50件と新規metadata UPDATE<=50/tickを必須。許容local中央値増分は50ms以下（リモートD1 SLOを意味しない）、対象SQLのEXPLAINも記録。性能向上は目的ではなく進行性のための追加書込みがboundedか確認する。

統合中の範囲調整: 既存7testsがbootstrap migration listを完全列挙しており、027追加に伴い新しい1行が必要。F20-input.jsonへ変更前hashを追加して7filesをwrite scopeへ追加。旧一覧/完全一致assertは保持し027のみ追加。初回integration-F20-verify.log exit1の7失敗はすべて当差分。検証を削除/緩和しない。

期待一覧の初回編集scriptがindent前提でassert失敗し未編集のままverifyが起動した。integration-F20-final2-verify.log exit1は同じupdate-engine一覧不一致で、製品の別不具合ではない。実際のindentを確認して1行追加後に再検証する。不要な再実行を隠さず記録。

## 受入結果
VERIFIED。旧schema上で実list/processor動作、停止行の再選択→delivered遷移、scope/単調時刻を含むF20-queue-final2.log6PASS。初回再開test失敗はbeta repository全mockがtransitionに必要なexportを消していたため、partial mockへ修正し実装を緩めず解決。package migration1PASS。旧テストは削除せず、新規6+1を追加、既存migration manifest8testは027一行のみ追加し完全一致を保持。

負荷F20-performance.json: N50/500/5000各3回、旧median0.377/0.310/0.300ms、新1.386/1.532/4.525ms。追加metadata UPDATE毎tick50、選択50維持、事前の増分50ms以内。EXPLAINは両版とも既存due index+一時sortを選択しており、新indexがこの合成分布で使われたとは主張しない。新indexはproduction plannerでの利用保証なし。リモートD1のlatency/costは未測定。

integration-F20-final3-verify.log verify:ci exit0、全型/tests/scripts/migrationチェック。F20-worker-artifact.json build0/runtime0、compiled scheduledを別harness入口から呼び出すreal D1 fixtureで1tick確認50→2tick累計51、clinical51行due/version1維持、outbound0。source/bundle未改変、runtime harnessのみ追加、credentials無しで本番送信成功の証明ではない。artifact取得後に変わったのはtestsのmanifest一覧のみなのでruntime結果を再利用。

P/W15paths hashをF20-input.json、全新規含むF20.patchを保存、隔離Pへ適用しW一致。historical migration/DBschema正本は未改変、新027のみ、bootstrap/metaはgenerate:bootstrap出力。Node26/pnpm11、CI Node22未実行。最終独立レビュー未実施。旧schema互換fallbackでは旧公平性の制約が残るため、本修復の進行性は027適用後に有効。deploy/production適用は未実施・未承認。

INTEGRATED d595215010ac956d5f697b7cc8083c26f3966787、15filesのみ。PLANS/evidence未commit保全、外部変更なし。全Goal達成とは別。

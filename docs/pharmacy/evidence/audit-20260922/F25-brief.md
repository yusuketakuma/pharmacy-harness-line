# F25 FIX — 有効期限通知の最新状態照合

RUNNING. P=fa43ab1e53a60e6154ad528a7ee2453e0774cbf4、/root dev checkout。CONFIRMED_BUG P2、validity-stale-date-case/log/resultでactualスタッフ期限訂正後の旧日付送信を再現。

Scope: sharedsender final dispatch query、actualSQLite回帰test、必要な既存mock fieldのみ。retryKey prescription-validity:<submissionId>:<date>とvars.genericDateの既存caller契約を維持してrecord解決。submission/account/friend、患者link（旧NULLlinkはNULLinputと一致時だけ保持）、current verified/ready/date/due/claim/sent stateと実送信時JST日付を照合。schema/API/payload/医療期間規則は変更しない。F23 unknown保持、confirmed sent replay、非validity通知のquery依存を維持。

Acceptance: 旧implementationでRED、staff訂正afterclaim/finalread、closed/cancelled/unverified/期限切れ/患者変更/missingforeignkeyを抑止、active送信/旧schema/legacyNULL patient/sent replay/unknown記録を確認。fullverify・compiledcronD1最終競合検証、snapshotpatch再現。最終DBread→provider間の原子性は保証しない。fresh最終独立レビューは全体として未完。

## 実装・検証記録

既存prefix/date suffixをSQLbind用submissionIdへ解決し、genericDateとcurrent valid_until、fresh実行時JSTtoday/due time、ready/verified/claimあり/sentなし、submission account/friend、patientlinkとinput patient一致を同一finalSQLで確認。legacy linkNULL+inputNULLは保持、patient付きが外れた場合は不一致で停止。追加joinsはvalidity message時だけ、他通知はconstant1 alias。公開入力field/result/API/schemaなし。

初期candidateは不適格時blockedへ終端化し、再確認後も同じkeyを使えない問題をF25-resume-red.log 1FAIL/15filter skipで発見。最終Wはpatient_retryableを返してproviderを止め、attemptedを残す。既存15分再claim/24時間horizonを保持し、無期限の自動復帰を保証しない。初期候補の近傍116PASSだけで採用せず、再確認回帰を追加。

旧P senderを別名temp moduleに展開してcopy testからのみ参照: F25-red.log exit1/7FAIL9filter skip（訂正afterclaim/finalread、closed/cancelled/unverified/expired/patient変更）。元working source巻戻しなし、temp内容照合後削除。初回のoriginal defectはvalidity-stale-date-log/resultに保存。

F25-near-final.log exit0、11files117PASS（新validity-dispatch16）。現/029前schemaのoldcaller正常送信+sent replay、actual staff saveとbefore finalSELECT訂正、状態変更/期限境界/患者解除、legacy no-link、missing/foreignaccount/wrongdate/prefix、unknown保存、actual再確認後16分再開を確認。日付依存はJS Dateを固定・afterEach復元、beta disabled/self patientの合成fixture、FK/check/triggers有効。provider/credential stub、staffsave/processor/sharedsenderは実装。

F25-worker-artifact-run.py build0/runtime0: compiled actual6h cron+localD1、合成暗号credentialを実decrypt、finalSELECT直前にcurrentdateを24→25へ訂正するDBfault injection。provider0、currentvalidity25/claimNULL/sentNULL、notification attempted、HTTP guardsPASS。current mainbundleとruntime filehash/bytes F25-worker-artifact.json。source側はactual save audit、compiled側は同じ業務結果の直接SQL注入で、両者を区別。既存F22の合成credentialfixtureを再利用、実secretなし。

P→W patch bothpaths isolated replay SHA一致、UIなし/非該当。Node26/pnpm11、CI Node22未実行。正式医療期限規則は変更せず、既存current state照合のみ。全verify進行中、fresh最終独立review未完。最終read後からproviderまでの競合・provider成功後のstamp更新競合を解消したとは主張しない。

## 25時間後の再開追補（前記Wを更新）

未送信と確定できる初回保留もattemptedのままでは、25時間後のスタッフ再確認時に24h reconciliationへ入り送れない。F25-delayed-resume-red.log exit1/1FAIL15filter skip、同一日付のactual再確認で再現。private validity_retryableを分離し、過去unknownの再claim以外はfailed（未送信）を記録して既存failed再試行を使用する。過去unknownはattempted保持し24h horizonを変更しない。16分/25時間をparameter化、17回帰cases。公開enum/input/schema変更なし。近傍3filesPASS、full/build/runtimeと変更部分の限定reviewを再実行中。以前のW/artifactはbefore-delayed名で保管。

最終W検証: `pnpm --dir apps/worker test src/custom/pharmacy/growth-loop/validity-dispatch.test.ts src/custom/pharmacy/growth-loop/sender.test.ts src/custom/pharmacy/continuity/dispatch-state.test.ts` exit0/3files64PASS (F25-delayed-resume-green.log)。`pnpm verify:ci` exit0 (integration-F25-delayed-verify.log)、全workspace typecheck/test、script tests、28 postbaseline migration checksを実行。`python3 .../F25-worker-artifact-run.py` build0/runtime0、compiled localD1 final訂正でnotification failed/外部送信0 (F25-worker-artifact.json)。全コマンド環境はenv -i PATH/LANG/TMPDIR/CI/NO_COLOR、buildのみWRANGLER_SEND_METRICS=false追加。新規schema/export/package/asset配置変更なし、browserはUI変更なしのため非該当。最終限定review待ち。

INTEGRATED `10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e`。限定review-final全文を親が読取り全2hash一致、index対象2pathと開始cleanを照合してlocalcommit。全体Goalは未完、freshreview未実施。

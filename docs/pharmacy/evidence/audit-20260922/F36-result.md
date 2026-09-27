# F36 受入記録
F36 FIX/CONFIRMED_BUG/P2、primary/dev。P=55c170b1c4ec61c54ef1a93bffb892f36d08c529、H/Bはbaseline.json。W2pathsはF36-W.json、F36.patch、隔離Pへ適用し2path一致確認済。

## 修復と保持契約
新規DSR受付がhold epochを1へ戻していた。先行resolveが古いreleasedを読んだ後、新PHI・別請求create/verify/assessで同じepoch3が再現し、古い判定でerasureをresolvedへ進めるABAを実SQLiteで確認。新規exactは同batchのscope内MAX+1、owner wildcardはその値を使う。
限定reviewにより既存CAS連鎖のe→e+1競合を追加確認。event/exact0行でもwildcardだけ古いreleasedを書込むことを実SQLiteで再現。commitTransition生成eventIdを両hold文に必須とし、失敗CASが書込を残さないよう修復。3callerはすべて渡す。
API/公開関数引数/認可/期間/日時規約/schema/旧audit/request versionは維持。新規migration/export/import/dependency/entrypoint変更なし。内部extrasのみeventId callback化し、event→exact→wildcard→requestのbatch順と例外処理は保持。初回epoch1とunknownも維持。既存14testを保全し6case追加。

## 検証
共通env -i PATH/TMPDIR LANG=C.UTF-8 CI=true NO_COLOR=1、Node26.6.0/pnpm11.25.0。F36-execution-status.jsonに観測済terminal session/exitを記録。
- 旧P初期DSR test 2FAIL14PASS（F36-red.log）。最終定義を隔離Pへ当て5FAIL15PASS（F36-final-red-corrected.log）。初回隔離runnerはroot scripts configを継承してNo test files、明示package configで訂正。製品不具合証拠に数えない。
- 初期修復16PASS後、限定review由来e→e+1を追加して1FAIL19PASS（F36-cas-red.log）。最終20PASS（F36-near-final.log）。両fence・元request/version・resolved監査0・別accountを実DBでassert。家族fixtureのself重複はchildへ修正、制約は弱めていない。
- 最終pnpm verify:ci exit0（F36-verify-complete.log）: shared builds、workspace types/tests、DB103files486PASS、Worker271files3020PASS、Web55files267PASS、LIFF28files205PASS、SDK/MCP/update/installer/lineSDK成功、scripts25files263PASS、28migration checker成功。中間verify成功はCAS修正により再実施、古いPASSで代替していない。
- compiled actual DSR route/repository + local Miniflare D1全bootstrap: F36-native-final.log/json exit0/egress0。初回epoch1→次受付4→verify/assess/resolve7→次受付8、exact/owner一致、stale409。artifact 96589B/SHA256 dcf3b042dfc7c428e3a615b18a769362a0bf55ea2d854569de01dfb9f1ee6ade。
- Native初回fixture staff account FK不足を訂正。その後既存legal-hold UNIONがD1制限でunknownになる別欠陥を検出（retention-union-investigation.md/F36-native-diagnostic2.log）。F36 nativeはaccess正常workflowとunknown failclosedを明示して検証。erasure正常完了は未確認、F37候補として次へ残す。実認可は固定合成server identity、実R2/本番操作なし。
- git diff --check0、isolatedpatch0。F36-limited-review/F36-final-reviewを親全文読取、最終W2hash照合・C1解消確認。再利用threadの限定review、fresh全体最終review未完。

## 再探索・制約
route/accountGuard/index順、DB tenant/account/owner/staff FK、state/event SQL、public consumerを対象限定確認。新規scope不備なし。malformed date候補はdata-subject-hold-review.md、実D1 UNIONは別packetへ。全source inventory/全retention/全repo完了とはしない。CI Node22/本番・実provider/全auth E2Eは未実施。PLANS/evidence差分保全、製品2pathsのみlocal commit予定。外部変更なし。

統合済: 6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b（2paths）。

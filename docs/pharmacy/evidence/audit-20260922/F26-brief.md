# F26 FIX — 未送信の一時保留を再開可能にする
RUNNING。P=10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e、primary/dev。CONFIRMED_BUG/P2、paused-resume-red.log。書込sender.ts、sender.test.ts、continuity/dispatch-state.test.ts。F23/F25依存。
保持: 公開入力/結果/retrykey/schema、恒久blocked、provider unknownのattemptedと24h horizon。意図的差分: claim後provider未呼出の一時gateでは、以前unknownでなければfailedを記録し既存retry経路に戻す。tenant pause/patient retryable/operations blockとvalidityを同じ規則で扱う。claim前gateはledgerなしを保持。
検証: 25h再開REDからGREEN、初回とprior unknownを区別したactual SQLite、sender unitでpostclaim/final patientとoperations/tenant gates、近傍/fullverify/compiledD1、限定read-only review、isolatedpatch再現。最終read/provider間raceの解消は主張しない。fresh最終review未完。

F26-R1追補: reviewer静的懸念をactualSQLite再現(F26-race-red.log exit1/1FAIL23filter)。A新規claim→16分停止→B実sender再claim/providerUnknown→A一時gateでB unknownをfailedへ上書き。現在のprivate markOutcomeをaccount/key/attempted/claim時occurred_at一致のCASへ変更する。caller全て同一sender内、既存claim/reclaim時刻を渡す。新schema/APIなし。一般成功/既知失敗/blockedの遅延finalizeにも同じ所有条件を適用する。最初のW全検証は成功したが新Wには再検証を要する。

最終W近傍はF26-final-near.log、3files75PASS。競合3ケース（古いgate/古いprovider成功/既知失敗）で新所有者のunknownと時刻保全。private markOutcome全6callにclaim時occurredAtを追加、sent/failed/blocked結果更新はattemptedかつ所有時刻一致のみ。受信したprovider成功のpublic戻り値は従来どおりで、行を古いownerの結果で上書きしない。claim timestampは既存列で追加schemaなし。全verify/compiledartifactは新Wに対して再実行する。

最終検証完了: `env -i PATH=... LANG=C.UTF-8 TMPDIR=... CI=true NO_COLOR=1 pnpm verify:ci` exit0 (integration-F26-final-verify.log)、全workspace typecheck/test、script23files246tests、postbaseline28migrations PASS。同制限環境+WRANGLER_SEND_METRICS=falseで`python3 .../F26-worker-artifact-run.py` build0/runtime0。生成Workerをsource非依存runtimeへ移しlocalD1で送信直前期限訂正→failed/no-providerとHTTP guardsを確認 (F26-worker-artifact.json)。compiled側はF25シナリオの共通patient_retryable/CAS回帰であり、25h/並行制御自体は実SQLite source testsで確認。性能変更は小さな条件追加、性能向上の主張なし。Node26/pnpm11、CI Node22未実行。UI/export/package/schema変更なし、browserは非該当。全source3hash/patchをisolated Pへ再現済。限定review更新待ち。

INTEGRATED `362737be415b11577535486a6d68f7d67edd728b`。親が限定review-final全文と3hashを照合、index3pathだけstageしてlocalcommit。fresh全体reviewと残domain監査は未完。

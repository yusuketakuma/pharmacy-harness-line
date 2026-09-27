# F38 受入記録
F38 FIX/CONFIRMED_BUG/P2、primary/dev。P=3158e7c337a3d43022b1db6fd0a4ce0fc4877257、H/Bはbaseline.json。W5pathsはF38-W.json、F38.patchの隔離適用で全W一致を確認。

## 根拠・差分・保持契約
JSのshape+finite検証は存在しない2月30日や24時を正規化して有効な保存期間起算日/解除日としていた。shared SQLはGLOB shapeだけで実暦日を検証せず、さらにpatternがnative D1制限を超え正規日時でも例外となった。retention-date-probe.json/初期REDで確認。RETENTION_MATRIXのmalformed=unknown/保持契約に沿い、JS3判定箇所にISO roundtrip一致、SQLはlength24+strftime(...,'+0 seconds')一致を追加。SQLのnow bind1個と比較/NULL処理は維持。
期間3年・正当閏日+3年の既存March1挙動、33source/66bind/単一SQL、public exports/関数引数/認可/tenant scope/schema/状態/保存形式を維持。新module/dependency/entrypointなし。非canonical入力だけ安全側へ変更、native正規日時は実行可能に。低水準legalHoldReleaseAtの直接呼出し前提は変更せず、その上位判定を修復。
既存testsを削除/緩和せずunit5・consumer5・native1case追加、既存native source testに不正暦日を追加。全不正入力や全削除経路を網羅したとはしない。

## 実行・証拠
F38-execution-status.jsonに観測済terminal session/exit。env -i PATH/TMPDIR LANG=C.UTF-8 CI=true NO_COLOR=1、native WRANGLER_SEND_METRICS=false、Node26.6.0/pnpm11.25.0。実データ・外部通信なし。
- 旧P初期unit3FAIL7PASS、native1FAIL1PASS。最終test定義を隔離Pでworker7FAIL59PASS、native2FAIL（F38-final-red-worker.log/F38-final-red-native-corrected.log）。初回隔離nativeはbase tsconfigコピー不足でtest未実行、訂正後のみRED証拠とする。
- W近傍: Worker3files66PASS（F38-consumer-green.log）、DB native+DSR22PASS（F38-db-near.log）。実SQLite purgeで不正DSR→exact/owner unknown、R2 put/delete0、file ready/purge log空を確認。最終SQLだけを通す競合fixtureでvalid expired leapdayはcommit可、不正日/月はCLAIMED保持。native SQLでexpiry当日/1ms後/valid leapday/不正暦日/NULL/nonUTC/hold0/未確認statusを確認。
- pnpm verify:ci exit0（F38-verify.log）: shared builds/workspace types/tests、Worker271files3030PASS、DB104files488PASS、Web267/LIFF205/他workspace成功、scripts25files263PASS、28migration checker成功。
- F38-native.mjs compiled actual DSR routes/repository/localMiniflareD1: 正常erasure全workflow、stale409、generation8、compiled JSとnative shared SQLのvalid/invalid判定一致、egress0。F38-native.json/log exit0、artifact97883B/SHA25604a6f329fa30b43d27caa378b4566e24d4a14a64025574d97a05387d774213b8。固定合成server identityでありfull auth/実R2削除ではない。
- F37と同じ関数/fixture/50,500,5000件/warm3+9回/閾値を実行前に再利用。F38-performance.json: P→W中央値(ms)0.200→0.220/0.293→0.507/1.447→3.681。ISO再検証コストは増加、事前W<=max(2P,P+15ms)内。query1/66bind/SQL7289B/33inventory/9export不変。性能改善や大規模本番性能の保証とはしない。
- git diff --check0、isolatedpatch5path0。retention-date-consumer-reviewを親全文読取・P2hash確認。限定修復レビューは別記録へ。

## 残項目・統合注意
不正日時を通常APIから発生させた本番事例や実患者データ削除は観測していない。合成fixtureで既存malformed保存値と競合を扱った証拠。制度・法的保存期間自体を検証/変更したものではない。CI Node22/全auth/全retention/全体fresh独立reviewは未実施。共有SQLの2consumerは同一exportを使用、incoming既存20caseとstatic wiringを再利用し独立malformed raceの追加は処方せん側に限定。
既存PLANS/evidence差分保全。今回5pathsのみcheckpoint対象。push/deploy/本番・外部状態変更なし。

限定review: F38-limited-review.mdを親全文読取・5hash一致確認、阻害findingなし。親が最終66PASS/22PASS/全verify/native/性能を直接確認して受入。fresh全体reviewではない。
再探索: source selection/preflightの77byte GLOBでもnative LIKE or GLOB pattern too complexを再現。retention-selection-glob-probe.json、F39次packet。今回のDSR predicateと区別し全retention完了としない。

INTEGRATED f6a88eedd15094ea52162ac168856647de0aedc8（今回5pathsのみ）。

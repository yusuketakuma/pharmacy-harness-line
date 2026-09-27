# F26-R1 修正後限定再レビュー

ID F26-LIMITED-FINAL-20260922、担当 /root/audit_db。既存thread再利用、fresh最終独立レビューではない。
P=10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e。更新W全3hashを入力と照合、一致。旧F26-limited-review.mdは保持。

## 解決判定

F26-R1の古いcallerによる新しいattempted上書きは更新Wで静的に解決。新規修復阻害findingなし。markOutcomeはaccount/keyに加えてoutcome=attemptedとoccurred_at=当該claim時刻を要求する。A→15分超→B再claimではBのoccurred_atが更新され、AのCASは0件となる。sent/failed/blockedの別stateも変更しない。
全6caller（postclaim patient、final patient、一時final gate、恒久final gate、provider既知失敗、provider成功）が同じsender冒頭のoccurredAtをclaim identityとして渡す。finalNowや結果取得時刻を誤ってclaim条件へ渡さない。初回/knownfailed claim、unknown reclaimはいずれもDBにそのoccurredAtを設定する既存処理と対応。
unknown catchは結果更新せずthrowを維持。初回未送信failed、恒久blocked、priorunknown保持、25h再開、既存horizon、公開契約/schema/retrykeyは先のF26方針を維持。

## 回帰と読取

更新F26-input全文、sender P→W全差分、dispatch-state.test.ts末尾3競合tests全文。旧sender.test hashは前回Wと同じため前回読取を再利用。
古いgate Aの途中で16分後B実sender+UnknownOutcomeErrorを実行→Aがpauseを見るcase、古いprovider成功/既知失敗Aの途中でB unknownとなる2casesが、BのattemptedとB時刻保持をassert。実SQLiteでSQL所有条件を検証する設計。primary RED/near75報告は受領したが本reviewで独立実行していない。

## 限界

CAS0件でもmarkOutcomeはvoidで、古いprovider成功callerはsentを返す既存result契約を維持する。provider成功という外部事実と新しいledgerがunknownであることを区別する保守的動作であり、新しいunknownを古い結果で確定しない。
この変更は遅延callerのprovider開始自体を排他しない。最終read→provider間競合、外部APIのexactly-once、同じretryKeyに対する下流dedupe、結果不明の自動照合を完成させたとは扱わない。
claim時刻は独立UUID tokenではない。stale attemptedの通常reclaimには15分以上の時刻差が必要なので確認したR1を防ぐが、任意時計巻戻し/同時刻の別世代再利用まで一般化した所有保証ではない。既存input.nowやclock運用の極端なケースは未検証。

## 実施・統合

cat/git diff/tail、Python hash/read_bytes/git show/git rev-parse。P/W全3一致。本記録以外の変更なし。test/build/外部/実DB/spawnなし。失敗なし。fullverify/artifactは依頼時進行中で結果を代弁しない。
primaryは更新Wの統合/成果物検証とhashを照合して採択。本記録をfresh最終独立レビューに数えない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | 3bfcde9eb5fd23e94eaa02e9a92902e63ccd8f302dee15a15f16f78f22d1761e | 45e5a35205be44b210873884506d2dd40c2e3a7a344251e4d00fcb27a95af32f |
| apps/worker/src/custom/pharmacy/growth-loop/sender.test.ts | 1ff5767a5dee5aeb397c147a772cf3857c4bb49ede1e22ba836e9e4c8f78b91c | 1a7bf3f6515106b34b436c8d2026eb9549731fb865ff1ce66cc2477d64bf60d3 |
| apps/worker/src/custom/pharmacy/continuity/dispatch-state.test.ts | 0742fd0896eb1f82349a1d607bc0b8ff804a356ed7fb6c1d1245396cc4837a6d | a6eeedab3b9428f9efbdd4d31f457fd602c3f9eb176391c183aaf8d83d33bd2b |

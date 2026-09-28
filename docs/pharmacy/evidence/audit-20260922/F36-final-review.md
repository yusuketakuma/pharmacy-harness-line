# F36-C1 修復後限定再レビュー

ID F36-LR-R1 / audit_db、P `55c170b1c4ec61c54ef1a93bffb892f36d08c529`、HEAD一致。既存thread再利用、fresh最終全体レビューではない。初期F36-limited-review.mdは保持。

| path | P SHA256 | 最終読取W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/data-subject-requests/repository.ts` | `218af0825f406b0c2afb9e3bc5cfc98301b74e7e211c34987964c9009aa0639f` | `8400a5b15269d96c172ef101cf30164309d4a7138133271c11b78f879226f57f` |
| `packages/db/test/custom_038_pharmacy_data_subject_requests.test.ts` | `2a194b9460e5d79282703e9f687500295675f62501a80f789ecf5e3233cdea6e` | `a7292582c9b42c03bebaa086a22315b1251af4c8e9da32712b69c34cdacad6b8` |

結論: F36-C1は対象経路で解消と判断（静的確度高）。commitTransitionが生成したeventIdをextras callbackへ渡し、全3caller（verify/assess/resolve）がtransitionEventIdとしてexact/wildcard両方へbindする。eventのID/request/account一致が必要なため、e→e+1の他者更新で先行eventが0行となった場合はwildcardも0行となる。『他者のe+1』を自分のexact成功と誤認しない。request UPDATEの既存event存在チェックも維持する。

event→exact→wildcard→requestの同batch順序は不変。eventが成立した後のSQL例外はD1 batch rollbackに従い、0行のCAS conflictでは当該event不存在を使って後続書込を止める。新規createにはtransitionEventIdを渡さないが、その経路は新UUID request作成とreceived eventが同batchであり、既存transitionのstale評価を持たない。MAX+1/同世代wildcardのF36初期修復とscope/旧API/初回/家族/別account判断は維持する。

新回帰は競合を追加受付一回と追加受付+verify+assessにparameterizeし、A conflict後の元request/version/監査resolved0/両fence latest statusをassertする構造。独自実行はしていない。親報告cas RED1FAIL19PASS、near20PASS、旧P最終5FAIL15PASSは申告として記録。F36-native-final.logは実際に読み、PASS/exit0とcompiled artifact hash、access正常世代推移・stale version・unknown failclosedを確認。native erasure成功の証拠ではなく、UNION limitをF37別問題とする制約をそのまま保持する。

読取: 最終git diff repository全体、test追加競合部390–448、native-final.log。既読初期reviewの範囲を再利用。P/W hash採取はPython hashlib/git show/git rev-parse。source/Git書込・独自test/native/fullverify/外部/実データ/secret/spawnなし、記録のみ作成。commit/patchなし。

統合注意: 最終2hashと親20case/fullverify-complete/actualD1結果を結び付ける。fullverify進行中をPASSと主張しない。malformed dateやUNION limitは今回の修復完了に混ぜず別packetへ。公開API/schema/期間変更なし。全DSR/retentionの安全を保証するレビューではない。

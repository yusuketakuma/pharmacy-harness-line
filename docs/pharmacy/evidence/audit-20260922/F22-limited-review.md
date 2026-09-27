# F22 限定read-onlyレビュー

ID F22-LIMITED-20260922、担当 /root/audit_db。既存thread再利用、fresh-context最終独立レビューではない。
P=24c336a50466d0afd8190576efb5a4ca529a880e。Wは下表。F22-input.jsonと全P/W SHA256を実ファイル/git showで照合、一致。

## 結果と保持契約

訂正: 追加反証で修復阻害finding F22-R1を確認。以下末尾の訂正が初期判定に優先する。限定静的レビュー。親のRED/near78/fullverify/compiledD1 PASSは独立した実行証拠であり本判定の前提にしない。
既存continuity callerのretryKey next-intake:<id>をそのまま使用。新field要求、payload/API/schema変更なし。固定prefixからsliceしたIDをSQL bindし、SQL補間しない。空/不正prefixはNULLまたは未一致となりfail-closed。
expectationはid/account/friend/patientを同一JOINで照合。parent obligationはid/account/owner/patientを全て一致させる。patientJoinと既存patientScopeはarchive/binding/consent/proxy等を引き続き照合。friend宛先一致、active tenant/account、capabilityの既存最終確認も保持。
active以外のended/linked/fulfilled/reminded/accepted/不存在はblocked、pausedはpatient_retryable。parentもactive/paused以外はblocked。acceptedは既存claim処理でactiveへ遷移後に送る契約なので新しい送信許可を増やさない。
pausedはfinalDispatchStateからmarkOutcome(blocked)せずattemptedを保持。既存15分stale再claim/24時間horizon/結果不明reconciliationを変更しない。無制限の再開可能性は保証しない。
confirmed sentの再送は既存already_sent早期returnで新provider呼出なし。終了後に送信済みledgerを消す変更もない。
continuity以外は新JOINを追加せずNULL aliasのみ。SQL placeholderはcontinuity時にだけexpectationId/patientIdを追加し、patient/beta/followupの既存bind順序と対応。新028 metadataを参照せず、直前schemaで動作する構造。
fixture既存変更は最終SELECT返却へactiveの2fields追加だけで、assert削除なし。

## 読んだ範囲

F22-brief/input全文、sender.ts差分、getFinalDispatchStateのpatientJoin/scope/新JOIN・bind・判定、sendPharmacyAutomatedPushのclaim後からprovider/markOutcomeまでを部分読取り。dispatch-state.test.ts全文、notifications.test.ts差分。continuity既存callerとclaimはF21での既読結果を再利用。sender全前処理・全beta/credential/LINE proxy内部は今回再読していない。
テストコードは旧schema/現schemaの実caller成功とsent replay、終了直前/最終read競合、parent pause/resumeとattempted、terminal parent3種、missing/foreign account/wrong patient/wrong prefixを確認する。SQLite fixtureはFK有効、外部providerはstub。実行は本reviewでは行わない。

## 限界・除外

最終SELECTとprovider呼出間の終了・停止競合は残る。外部送信との原子性を保証しない。
paused16分後の例は24h内。24h超とunknown outcomeの自動解除は本修復の対象外で既存制約を保持。
旧schemaとは028追加前の対象fixtureであり、continuity table自体が存在しない任意の古いschemaをsupportする主張ではない。他通知は新table JOINを生成しない。
wrong-friend単独/expectation単独paused/全terminal expectationの専用testは追加差分にないが、JOINと同じstatus allowlistで確認できる。未実行の網羅PASSには数えない。
既存sharedsenderによる入力keyとledgerの広い権限制約・final read後のscope remapは今回の新差分全体安全性として検証していない。

## コマンド・結果・統合

git rev-parse HEAD、git diff、cat、sed、rg、git diff --check（出力なし）、Python read_bytes/hashlibとgit showによるP/W照合。test/build/外部API/実DB/spawnなし。コード/Git変更なし。本記録だけ作成。
最終sourceのSHA256一致をprimaryが再確認して統合。既存threadレビューをfresh最終独立レビューに計上しない。親の検証ログと本静的判定は分けて保存する。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/continuity/notifications.test.ts | 546dc32ecaa30e945c7ca89f993b377f2d478acf7cece9f2be0916cb5eeb77de | bee398a758b4d0c830f65f9a9ade39d088b2f61aeef0d47272c9081655d9ddab |
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | 72da8e899de33062f0aadfc29584f2cddf232239c58b1d47e9591536a860a339 | deb7b05d3764d2b2caae02b6a47cfad9db1b0ce43b90d323b39b014eee559c79 |
| apps/worker/src/custom/pharmacy/continuity/dispatch-state.test.ts | 不存在（新規） | 71a98744489660e7da0c9345f1773e4b6ac11f160b64f3358d284641ede10498 |

## 追加反証・判定訂正: F22-R1

分類CONFIRMED_BUG（静的経路確認）、重大度P2、確度高。実行再現未実施。Wは変更なし。
既存attemptedはproviderが受理したが返答が不明の場合も保持する状態。sender.ts476–490は15分経過・24h以内のattemptedをoccurred_atだけ更新して再claimする。その後、F22で追加したexpectation/parent ended判定はblockedを返し、543–546のmarkOutcome(blocked)へ進む。markOutcome65–70はoutcome <> sentだけを条件に上書きするため、結果不明attemptedをblockedとして確定してしまう。以後blockedは早期throwされ、既存24h reconciliation_required経路にも入らなくなる。
初回provider未呼出のblockedは妥当だが、過去attempted再claimは異なる。新たな送信は抑止しつつunknown ledgerを保持し、reconciliation_required等で返す区別が必要。重複送信の実証ではなく、送信結果不明という保全情報を失う欠陥。
最小回帰案: 実sender初回provider stubをLineHarnessUnknownOutcomeErrorで拒否→attemptedを確認→occurred_atを16分前へ（created_atは24h内）→実end処理→再deliver。追加provider呼出0、outcome attempted維持、reconciliationへ移れる結果をassert。別ケースで初回endedはblocked、paused16分再開、confirmed sent replayを維持する。
追加読取: markOutcomeとrecordBlocked、stale attempted再claim。実行コマンドsedのみ。初期の親PASSを根拠としないとの姿勢は維持するが、初回静的レビューはunknown分岐の合成を見落としたため訂正する。primaryへ同findingを即時通知済み。本Wの受入はこの点の修復・回帰検証まで保留。

# F22 FIX — 終了・停止された継続案内の送信抑止

RUNNING. P=24c336a50466d0afd8190576efb5a4ca529a880e. Owner /root, dev checkout. Repro: continuity-stale-send-case/log/result, actual claim → actual staff end → actual sender → stub provider invoked1 then helper failed. CONFIRMED_BUG P2.

Write scope: growth-loop/sender.ts, focused continuity dispatch tests, existing continuity notification test fixture only as required by added final state fields. No schema/API/notification payload/retry key change. Existing caller identifies expectation with next-intake:<id>; retain this exact input contract, resolve server-owned record at final dispatch. Scope by account, friend and patient and matching parent obligation. Ended/linked/fulfilled/missing/cross-scope state blocks provider. Paused state must not permanently burn retry key. No effect on other message types. Remaining interval between final DB read and external send is not claimed atomic.

Acceptance: before/after reproduction, actualSQLite successful old-caller flow, staff end before/at final read, parent pause/terminal states, absent/foreign/wrong patient IDs, already-sent replay, oldschema independent of028 metadata; near sender+continuity+patient/beta consumers; full verify:ci and isolated compiled Worker/cron smoke. Tests preserve effective prior behavior outside cancelled/stale domain. New regression tests only, no assertion weakening. Fixed simple query adds at most two primary-key joins for continuity sends, no extra provider call. Independent fresh global review remains outstanding; this packet does not complete whole audit.

## 実施済み検証

- Psenderを別名の一時moduleへ展開し、コピーした回帰testからのみ参照: F22-red.log exit1、終了前/最終readでの終了2FAIL、他10は選択filter除外。元作業ファイルの巻戻しなし。旧再現はprovider stub1call+helperfailed、新回帰はskipped/0call要求。temp filesは内容照合後除去。
- F22-near-final.log exit0、8files78PASS（新dispatch12、既存continuity38、sharedsender28）。初回wrong_patient fixtureがself患者unique制約に違反したログF22-near.log保存。元患者をotherにしてから別患者をselfへ変更するfixture修正、constraintは維持。
- integration-F22-verify.log: pnpm verify:ci exit0、全workspace types/tests/scripts/migration policy。新input/API fieldなし、既存notification testのfinal-state mockへactive domain2fieldsを追加したのみ。
- F22-worker-artifact-run.py: build0/runtime0。F22-worker-artifact.jsonに配布物hash/bytes。isolated current compiled Worker + real localD1、合成暗号化credentialを実read/decryptしてsharedsender最終SELECTへ到達。harness DB wrapperがSELECT実行直前に期待行をended/version2へ変更: claimed1/skipped1、notification blocked、external0。harnessがデータ競合を作るだけでshipping entry/senderは未変更。fixture暗号文はF22-synthetic-credential.mtsがsource encryptionで事前生成した明示synthetic値であり実secret不使用。既存HTTP auth/feature/webhook checksもPASS。
- F22-input.json/patch: isolatedP+patchで全3W SHA256一致。runtime Node26/pnpm11、CI Node22未実行。UI変更なし、画面検証非該当。migration変更なし。
- 送信直前SELECTとprovider呼出しの間の競合はatomic保証できず残る。confirmed already_sentは既存早期reconcileのまま新sendをしない。pausedは既存attempted/15分再試行/24時間provider horizon方針を保持（16分後の再開を実証）。24時間超や結果不明の自動解除を追加せず、既存reconciliation_required制約が残る。無制限の停止解除後送信を保証しない。

## F22-R1 修正と再検証

初期Wの反証でCONFIRMED_BUG: stale attempted（過去のprovider結果不明）をdomain ended判定後にblockedへ上書き。F22-unknown-red.log 1FAIL（12filtered skip）、actual sender/SQLite+UnknownOutcomeErrorの再現で確認。限定reviewも静的に同findingを確認。初期input/patch/review/成功ログは履歴として保存し、最終PASSとして流用しない。

最終W: final domain判定を内部continuity_inactiveとして区別。既存attemptedを再claimした場合だけreclaimedUnknownAttempt=trueとし、inactiveで追加送信は抑止するが過去attemptedは上書きしない。初回provider未呼出はblockedのまま、他通知/既存patient/account guardの動作は変えない。13個目の回帰はunknown初回→実end→16分後retry→provider追加0/outcome attempted保持→25時間後reconciliation_requiredを確認。

F22-near-revised.log exit0/79PASS、最終P→W patch replay3paths一致。最終統合・build/runtime再確認中。新規公開result/API/入力fieldなし（内部FinalDispatchStateだけ追加）。

最終統合検証: integration-F22-final-verify.log exit0。最終build/runtime: F22-final-worker-artifact-run.log/json、双方exit0。最終hashでcompiled cronの直前終了遮断がPASS。初期成功を流用せず、変更依存範囲を再検証済み。ローカル模擬providerのunknown回帰はsource+実SQLite、compiled runtimeは初回キャンセルを検証し、compiled unknown再送専用caseは未実行。最終限定レビュー待ち。

隣接未確認: 既存sharedsenderの一般patient/account gateでもrecordBlocked/markOutcomeが過去attemptedを書き換える可能性がある。F22は追加したcontinuity domain guardのunknown保全を対象とし、既存全gateの履歴意味論を安全と主張しない。別途具体的な再現・契約確認へ回す。

## Checkpoint

INTEGRATED local commit 538de9f680ce5360aa00b59e5953382fafa56aa6. F22-limited-review-final.mdを全文受領・全3hash照合、R1解決判定と最終verify/build/runtime成功を照合。全体Goal未完。

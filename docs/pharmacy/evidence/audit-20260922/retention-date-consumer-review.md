# F38 preparation: retention date consumer regression位置

ID RDC-LR / audit_db。P `3158e7c337a3d43022b1db6fd0a4ce0fc4877257`、静的限定、既存thread再利用。製品/test編集なし。

| path | 読取SHA256 |
|---|---|
| `apps/worker/src/custom/pharmacy/prescriptions/retention-purge.test.ts` | `862a562c6f8b06347087445472b8d486fe79d87bcefd09fc182e6424828f739a` |
| `apps/worker/src/custom/pharmacy/retention/incoming-images.test.ts` | `ef06d75d64398b193f7699453d0dede5d1debf6c56bdba0df3fd0adde618844a` |

最小追加は3箇所。

1. **実fence/処方せんpurge:** retention-purge.test.ts:500のreleased hold正常系の隣。既存insertFile→attachPatient(OLD)→seedLegalHoldを再利用し、releaseAtを過去年の不正日 `2020-02-30T00:00:00.000Z` に置換するparameterized case。helper:164は文字列比較でfenceをreleased seedするため、実prepareRetentionFenceがoverlayからunknownに再判定する検出力を持つ。期待purged0、skipped1、R2 put/delete0、file ready保持、purgeLog空、exact/owner unknown。実date正常expiredを対照として残す。実在しない月99は現Date.parseですでにunknownなので、JS roundtrip差分REDはFeb30/24時を使う。

2. **処方せん最終SQL:** 同file:559の `does not commit after a hold appears between claim and commit` が最小の再利用先。prepareRetentionFence→createDeletionIntentのreleased claimまで同じ。既存のhold epoch increment部分の代わりに、対応DSRのlegal_hold=1/status=legal_hold_assessed/releaseAt=過去のmalformedを設定し、hold epochを変更せず旧released値を維持する。続くcommitDeletionIntentを既存引数で呼び、false/intent未commitをassert。再度prepareRetentionFenceを呼ぶとJS overlayで先に止まりSQL述語の検出力がなくなるので、意図的に最終SQLだけを通す。seedLegalHoldは既存fenceとINSERT衝突するのでそのまま呼ばず、insertReleasedFileが既に作ったDSRをUPDATEする。request日時/audit FKは既存fixtureを再利用。

3. **incoming最終SQL:** incoming-images.test.ts:296 `does not commit an incoming delete when a DSR appears after fence refresh`。既存racingDb.batchが2回目のfence batch直後にreceived DSRをINSERTする。そのINSERTをlegal_hold_assessed/hold1/malformed releaseに替え、identity_verified_at/legal_hold_assessed_at/basis等は直前:258のheld race fixtureから流用。scopeはtenant-a/account-a/friend-a/patient-a、epochは更新しない。purgeTrackedIncomingImages→最終activeDSR SQLが止まり、delete0、CANCELLED_UNKNOWN/stored_sha256 nullという既存期待を保持する。`batches===2`は既存hook依存なので最終SQL到達をassert/traceで確認する。

incoming実fenceだけの回帰が必要なら:258のR2.get callbackに挿入するhold日時をFeb30へ替える。未知の時はCANCELLED_HELDではなくCANCELLED_UNKNOWNが期待候補。処方せん側で実overlayを十分検証すれば重複は必須でない。

保持: 有効expired/未来held/null/nonUTC、正当閏日+3年の業務挙動、scope/epoch/intent/state/R2保全。新fixtureが他のunknown sourceや未承認executionで早期停止すると偽陽性になるため、既存released happy pathを最小変更してRED確認する。

読取: 指定2testのfixture:164–195、472–525、530–602、incoming:258–347。rgで関連test位置探索、sed本文確認。最初に誤path retention.test.tsを読もうとして不存在、rg --filesでretention-purge.test.tsへ解決。独自test/SQL/外部/実データ/spawn未実施。source/Git変更なし、hashはPython/git rev-parseで採取。記録のみ作成。predicate/roundtrip unit/nativeは主担当の担当と重複させない。全feature/fresh全体レビューではない。

# RECOVERY-CONSUMER-20260922-02

担当/root/audit_db、開始終了HEAD b0eb1bde24a36f66c21a8d544d0f48d54047d047。recovery-investigation/F08を再利用、同じfinding再提出なし。read-only、コード/Git/patch/commit/外部DB/spawnなし。

範囲: recovery/operations.ts assertRecoveryExecutionのSQL/失敗処理、retention/execution.ts、prescriptions/retention-purge.ts finalize148–240/削除直前285–333/tombstone reconcile位置、retention/fence.ts inventory/activeDSR部分（出力省略、全文扱いしない）、incoming-images.ts tombstone呼出位置だけ、platform-admin/data-protection-routes.ts preflight再生成・435–510execution/完了条件、immutable-r2.ts全文、RETENTION_MATRIX現行契約/blocker。

保全: execution proofはoperation/fence JOINでoperation ID、tenant/account/environment、種別、executor、execution ID/fence token、active/期限を照合。retention/executionはretention_delete固定。routeはpreflight再生成/照合後execution検証、purge consumerは削除前execution/hold再確認。manifest全digest比較の今回再読は未実施。

処方せんfinalizeはfile ID/R2key/SHA/revision/元state/deletion intentを条件とし、purge log/FINALIZED_DELETEDも同batch。既存purge logのkey相違はOUTCOME_UNKNOWN。R2 tombstoneはETag一致条件で同keyを空body+専用metadataへ置換。通常writer putR2ObjectOnceはetagDoesNotMatch:*で上書きせず、retry成功はSHA一致を要求。tombstoneを残す限り旧bytesの同key再PUTは拒否。親のprescription upload経路も同helperを使用（F13読取り照合）。

懸念: finalizeは直前にexecution検査するが各UPDATEのSQLにはlive fence JOIN無し。失効後の既R2削除結果の記録を禁止すべきかは後処理契約次第、復活/越境の証拠ではない。

重要な未確認: backup復元時に現在のtombstone/deletion intent/purge logを旧snapshotで消さず照合する実consumer、全R2 writer/外部復元作業、incoming-images mutation全体、旧operation OUTCOME_UNKNOWNを別opで回収する条件、全filereadのdeleted/tombstone拒否、D1 fenceとR2 PUTの間の失効競合。

RETENTION_MATRIXのDSR tombstone等policy blockerと統合readiness BLOCKEDを維持。この調査を本番削除/復旧承認や全復活防止の完成扱いにしない。新規確定欠陥なし。

実施はgit rev-parse/対象rg/cat/sedのみ。tests/合成fixture/実DB/LINE/外部復元は子未実施。親image入力検証とは独立記録。


## RESTORE-ENTRYPOINT-20260922-03（親による補足）

入力HEAD c9cb1ed5e01115e355db539304055d0e82665986、code tree clean、PLANS/evidenceは既存の今回記録。変更は本受入記録のみ。実データ/外部操作/テスト/復元なし。

調査範囲: scripts/custom/pharmacyのrestore関連入口、recovery/operations.ts backupMatches374–417、platform-admin/data-protection-routes.ts execute390–408とoperation dispatch参照、FIELD_LEVEL_ENCRYPTION_DESIGNの復元/rollback/release gate、RETENTION_MATRIX冒頭の現行契約。rg path globが存在せず1回失敗、実directory検索へ訂正。

証拠: recovery operation enumにはrestore_rehearsalがあるが、executeはfle_backfill/plaintext_scrub/plaintext_restore/retention_delete以外を409 `Operation is not executable by this route`で拒否する。操作種別の存在は復旧consumer実装の証明ではない。backupMatchesはverified generationのscope（tenant/account/environment）とmanifest/countの照合を行うvalidatorで、backup取得/復元を行う関数ではない。scriptsのrestoreはmigrate-line-credentials.tsの旧平文credential列の復元であり、全DB/R2snapshot復元ではない。

正式FLE文書は暗号化envelopeから旧列を復元して旧Workerとの互換を戻す段階を定義し、verified backup/restore drill/別principal承認をproduction gateとする。RETENTION_MATRIXは実backup/production deleteをNOT_RUN、DSR tombstone等のpolicy未決をBLOCKEDと明記。

結論: repo内に全DB/R2backup復元consumerがあるという仮定を撤回する。今回の入口/参照検索ではその実装を確認できず、現在のexecute routeからはrestore_rehearsalを実行できない。外部の復旧手順・信頼できるbackup・削除overlay適用証拠は依然必要。既存field-level restoreを全backup復元の保証に転用しない。新しいbackup機構を監査中に無断追加せず、既存の拒否と人のgateを維持する。

次にコード上で確認可能な範囲はintake/migrationのplaintext_restoreとread-old/write-newのCAS/認可。全backupからの削除済みデータ復活防止は外部証拠なしで完了扱いにしない。全領域監査・独立レビューは別途未完。

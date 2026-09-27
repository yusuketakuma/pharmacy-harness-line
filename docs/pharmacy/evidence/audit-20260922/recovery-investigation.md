# Recovery限定調査受入記録

ID AUDIT-RECOVERY-20260922、担当 /root/audit_db（再利用read-only）。P/W=375cf157c398c7644844e70dc3db9bd2f0dfcee2、開始終了HEAD一致。変更/commit/patchなし。対象C03/C10/X03はPARTIAL。
保持契約: server認可、tenant/account/environment scope、approver/executor分離、active fence一意、進捗単調性、結果不明時の盲目的削除禁止、既存migration不変。
実施: 対象限定git/rg/wc/sed/catのみ。編集/テスト/外部/実データ/secret/spawnなし。glob未一致1回後明示path修正、出力切断箇所は未読として扱う。

## F-REC-01 P2、静的に確定、実行再現・修復待ち

recovery/operations.ts markRecoveryProgress 781–815はread値に対してcount単調性をJSで確認するが、UPDATEはscope/proof/runningとlast_batch_id<>新batchIdのみ。readしたcount/cursor/lastBatchIdとのCASがない。data-protection-routes.ts428付近で同executorのrunning operation再実行可能。同じ旧count0を読む別batch A/Bが2と1を計算しA→B順にcommitすると2→1へ後退。確定影響は進捗・再開座標の不整合。実行済行破壊/越境は未確認。
completeRecoveryOperation824–849もexpected countをread時のみ確認、UPDATEにはcount/fence期限がない。同根候補だが誤完了再現未実施。
既存operations.test92–133は同batch逐次再送/異fence拒否、並行別batchなし。必要: 合成read後順序制御、snapshot CAS等、同batch再送/別batch競合/期限切れ/complete競合。

## 確認保全

requireOperationはID読取後scope一致。claimは承認/期限/別approver確認、期限fence処理・fence作成・running化をbatch。assertRecoveryExecutionはoperation/fence JOINでscope/executor/executionId/token/active/期限。routeはplatformAdmin本人を使いbody spoof拒否、scopeは保存operation由来。旧intake migrationはdryRun固定、freezeは409。
delete-intents cancel/unknown更新はproof/scope条件。prescription commitはhold/epoch/activeDSR/generation/owner/patient mappingを一UPDATEで照合。prescription/incoming reconcileはR2 head後確定、存在objectの盲目的再削除なし。plaintext restoreは同row暗号envelope由来、読取範囲ではINSERT復活なし。intake migration685–816はscopeCAS、migration state guard、batch終端dataset guard、cursor開封検証。

## Coverage / 未確認

- recovery/operations324–372,520–902主要経路PARTIAL、出力切断含む。
- retention/deletion-intents全文静的REVIEWED。
- platform-admin/data-protection-routes220–249,386–540のみ、middleware登録/末尾catch未読。
- intake/migration650–840のみ、cursor暗号実装/全coverage query未確認。
- prescriptions/retention-purge reconcile439–540のみ。削除本体/finalize未読。
- retention/incoming-images reconcile581–630のみ。purge/inventory未読。
- provisioning旧intake入口、recovery tests resume/idempotencyのみ。
- intake repository phase条件所在のみ、REVIEWEDではない。
- markRecoveryStale/Failed ID限定UPDATEは事前scope確認あり、grepだけでtenant欠陥としない。競合状態/fence解放未検証。
- 別operationへ移行後の過去OUTCOME_UNKNOWN回収未確認。reconcileは現operation/execution限定。
- tombstone後画像read consumer、backup実restore/復活防止全体未確認。plaintext restoreをbackup検証に代用しない。
- fence検査からmigration書込み間の競合とbatchguard組合せ未確認。

親のexecution/fence/preflight既読範囲と合算しても削除復旧全体PASSではない。親は原典・再現で採択判断する。

# INTAKE-RESTORE-20260922-01

入力c9cb1ed5e01115e355db539304055d0e82665986、担当primary。参照依頼再読、code tree clean、既存PLANS/evidenceのみ。製品変更/外部操作/新規test実行なし。

範囲: intake/migration.ts input/scope/readRows/readEnvelopes/decryptStored、coverage499–554、guard630–690、migrateLegacyFields690–835。platform-admin/data-protection-routes.ts migrationApproval/executeIntakeOperationとexecute直前assert、intake/repository.ts1103–1228の通常write freeze SQL。migration-fle-review.test.ts130–269/345–380。長い出力の省略箇所は全文確認扱いにしない。正式FLE契約は前ターンの同一資料を再利用。

確認した不変条件:
- APIから渡すapprovalはoperation.approverSubject/id/verified preflight由来。caller bodyの名義をauthorityにしない。
- migration inputはvalid tenant/account/root keys、limit1–50、封印cursorのmode/contextを検査。restoreはscrubbed/restoringからのみ。scopeのactive tenant mappingをcoverage検査で確認。
- readRowsはline_account_idとtenant mapping、envelope復号はrowのidentity/contextを用いる。partial/corrupt envelope、片方だけsentinel、平文との不一致は書込み前に停止。
- 既存approvalではcoverage total/digestがmigration stateと一致する必要がある。別approvalへのrebindはrestore初回cursor-nullで現在coverageを証明した場合のみ。dryRunはwrite前に戻る。
- restoreは2fieldとも{}の行だけをCAS更新。phase更新・state guard・データwrite・dataset guardを同batch。state違反はguard失敗でrollback、terminal時に{}残存があると完成を拒否。正常復元は検証済みdecrypted bytesを旧列へ戻す。
- 通常問診writeは事前stateだけでなくINSERT SQLでもfrozen/scrubbing/restoring/restoredとactive recovery fenceを除外する。復元との同時通常登録を抑止する。

テスト証拠の再利用: integration-F13-verify.log600行 migration-fle-review10tests、1301行migration4tests PASS。同一ソース。読取ったassertionは2row scrub→restore、dryRun無書込み、stale phase全rollback、late uncovered row terminal拒否、fresh approvalでdataset再bind、cursor他operation/改変拒否。全実環境と全競合の保証ではない。

残る懸念: outer route assertRecoveryExecutionとhelper batchの間にcoverage読取り/復号があり、helper write SQL自体にはlive execution expiry JOINがない。正常write freezeは確認したが、承認/fence失効とのraceを今回再現していない。復号後のenvelope/owner変化と復元CASの全組合せも未確認。判定を完了に格上げしない。

資源観点: migration1pageは最大50rowだが、各呼出のcoverageは全datasetを50件ずつ読み全件復号しdigestPartsを保持する。N件を全page処理する場合にcoverage再走査が反復される。許容N/実測時間・クエリ数は未確認のEVIDENCE_BASED_CONCERN。場当たり的な検証省略や承認snapshotの使い回しで速度改善しない。

全backup復元/全暗号化domain/独立レビューは対象外・未完。確定した新欠陥の提出なし。


## INTAKE-RESTORE-MEASURE-02

入力/成果snapshot: c9cb1ed5e01115e355db539304055d0e82665986、primaryによる診断のみ。製品source差分・契約変更・commitなし。既存PLANS/evidenceを保全。

事前条件: N=10/50/100/200、各3回、1page50件。既存SQLite fixture/暗号実装を使用し、seed/freeze/scrubを測定から除外。restore全pageの実時間とprepare回数、envelope SELECT回数を測る。60秒のプロセス上限内、既存Vitestデフォルト5秒の1test。性能SLOは未定義のため時間をPASS閾値としない。外部通信・本番データなし。各回別のメモリDBをfinally close。

コマンド: `pnpm --dir apps/worker exec vitest run src/custom/pharmacy/intake/audit-restore-measure.test.ts`。PATH/LANG/TMPDIRのみ引継ぎ、CI=true/NO_COLOR=1/WRANGLER_SEND_METRICS=false。一時testは実行後に削除し全文を`intake-restore-measure.test.ts.txt`へ保存。ログは`intake-restore-measure.log`、数値は`intake-restore-measure.json`。Vitest 1file/1test PASS、skip/failなし。ツールの初回yieldのsession IDを保存し損ねたためprocess exit codeの独立記録なし（PASS出力とfinally cleanup完了を確認）。

| 件数 | page数 | prepare数 | envelope読取り数 | 中央値ms | 最小–最大ms |
| --- | --- | --- | --- | --- | --- |
| 10 | 1 | 37 | 20 | 2.65 | 2.56–2.70 |
| 50 | 1 | 158 | 100 | 10.16 | 10.10–10.62 |
| 100 | 2 | 418 | 300 | 31.86 | 26.94–33.65 |
| 200 | 4 | 1244 | 1000 | 102.30 | 91.40–102.67 |

結果: 全件でrestored件数=N/最終phase=restoredを確認。envelope読取りは `N × (ceil(N/50)+1)` と一致し、各pageで全coverageを再走査する静的所見を裏付けた。prepareはSQL準備の計数でありD1ネットワーク往復や課金単位とは同一視しない。Node/ローカルSQLite時間で本番D1の遅延・CPU制限超過を断定しない。API側の追加preflight/coverageやexecution claimは測定外。before/after比較は変更なしのため非該当。

判定: EVIDENCE_BASED_CONCERNを維持。全件検証は改変検出契約に必要で、検証を省略する最適化は採用しない。本番想定N/予算と許容する検証方式が未確認。route451のlive fence確認とhelper SQLの間のraceは別の未検証論点。製品source不変なので既存統合PASSは再利用、全量検証反復なし。独立レビュー/全体監査は未完。

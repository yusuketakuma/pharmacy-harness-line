# F14 — 問診migration書込み時の実行fence失効

状態: PLANNED（欠陥再現済み、修正未実施）。分類CONFIRMED_BUG/P1。owner primary、worktree元dev。P=c9cb1ed5e01115e355db539304055d0e82665986。先行F08のprogress/complete CASとは異なるconsumer書込みの残存欠陥。同じlease不変条件の追加修復として扱う。

根拠: RETENTION_MATRIX.md19のAuthorityはexpiryとactive execution fenceを必須とする。data-protection-routes.ts451でassert後、503のexecuteIntakeOperationはmigration helperへexecution identityを渡さない。migration.ts803のDB batchはmigration state/datasetをguardするがrecovery executionをguardしない。書込み後のmarkRecoveryProgressは失効を拒否するので、データ更新済み・進捗未更新が成立する。

再現: 合成SQLite1rowと実create/preflight/approve/claim/assertRecoveryExecutionを使い、scrub batch直前にfence期限のみ過去へ変更。scrubはerrorCode=null/scrubbed=1/phase=scrubbed、両旧列{}。続く実markRecoveryProgressはEXECUTION_NOT_FOUNDで拒否。旧列不変assertがRED。これは失効fenceをJOIN条件で除外する実装によるコードで、初回FENCE_EXPIRED期待は不正だったため修正。初回失敗ログはintake-expiry-initial-attempt.logに保持。

検証記録: intake-expiry-red.log、intake-expiry-run.json（Vitest exit1）、intake-expiry.test.ts.txt（全文）。コマンドpnpm --dir apps/worker exec vitest run src/custom/pharmacy/intake/audit-expiry.test.ts、Node26.6、PATH/LANG/TMPDIR+CI/NO_COLOR、60秒上限、メモリDBはfinally close。一時testは削除済み。1testで契約違反を検出、skipなし。HTTP実経路全体ではなく実helperの順序再現。外部操作なし。

保持契約: account/tenant/environmentとoperation/execution/token/executorの同一性、旧helperのdryRun/既存呼出、暗号化bytes/coverage検証、既存schema/API/CLI、batch rollback。意図する差分は期限切れ・置換済みexecutionでのwrite拒否のみ。

修正候補範囲: intake/migration.ts、recovery/operations.tsのguard部（または同domainの限定helper）、platform-admin/data-protection-routes.tsと関連test。backfill初回2envelope batch、rewrap run、freeze/rebind run、scrub/restore batchを同じ実行guard方針で覆う。単なる直前await assert追加ではTOCTOUを閉じない。schema変更/本番適用は不要な方針を優先。既存constraintでrollbackを強制するguardパターンを調査済み、具体設計は未確定。

到達条件: 有効fence時の既存成功/古い呼出互換、batch直前失効・別execution・異scopeで全write rollback、routeがserver executionを渡すこと、関連Worker/DB tests+typecheck。変更後の統合チェックと影響するartifact検証を行う。現在は修正/green/commit/patchなし、未検証を完了扱いにしない。


## 実装中 checkpoint

状態RUNNING。migration scopeへ任意のserver executionを追加、routeから保存operation+認証済executorで組立てたexecutionを渡す。旧呼出は同じ経路を保持。全6write箇所（初回envelope batch、rewrap、freeze、rebind、scrub/restore batch）をmigrationBatch/migrationWriteへ接続。scope/operation一致とlive operation/fence JOINを同batchの先頭guardで検査し、不一致は既存migration phase CHECKでrollback。schema/API変更なし。

F14-near-expanded.logは35tests PASS（新規6cases: scrub valid/expired/replaced/foreign-account、restore valid/expired）、F14-type-expanded.log typecheck exit0。続いてfreezeの旧呼出時例外伝播を保全する変更とtest import整理を行ったため、最終sourceの再検証はまだ必要。backfill/rewrap/freeze各writeへの失効注入、HTTP server execution伝達assert、統合/配布物検証、diff/互換レビューが残る。未commitでRUNNING、局所PASSをpacket完了に扱わない。


## 検証 checkpoint（commit前）

WはF14-input.jsonのP+4path SHA256で固定。初回envelope/rewrap/freeze/rebindの有効・失効8casesとscrub/restoreの8cases（別account/環境/差替え/書込み中失効を含む）、既存10casesを合わせmigration-fle-review26tests成功。前後guardにより書込み中の失効もrollback。guard分の結果はsliceし既存result indexを維持。実行省略時は旧db.batch/runと旧freeze初回例外伝播を維持。SQL/保存schema/公開API/CLI/exportの削除変更なし、type-only execution optional追加。production caller全件を再検索し、旧provisioningはdryRun=true/freeze409、新platform routeだけserver executionを渡すことを再照合。

F14-final-near.log:4files61tests exit0。integration-F14-result.json exit0、integration-F14-verify.log:verify:ci全体成功（Worker2891/DB477/Web267/LIFF202/MCP36/installer80/updateengine228/SDK56/LINE8/scripts246、25migrations）。Node26.6.0/pnpm11.25.0、安全env。Node22 CI環境自体は未実行。既存tests削除なし、新規skipなし。identity spoof入力は既存recursive検査により400なので正常resumeと別assertに分離し既存仕様を保存。誤って200を期待した失敗ログF14-spoof-expectation-attempt.logと、その直後開始しSIGINT130で中断した統合logを保存。修正後に上記全量を実行した。

F14-worker-artifact-run.py/build.log/artifact.json:合成configのVite build exit0、隔離compiled成果物のMiniflare起動/401/薬局genericPOST403/DB無変更/list200/outbound0でexit0。全artifactのbytes/SHA256あり。一時build/runtimeディレクトリ削除済み。問診executeのHTTPから実D1書込みまでの成果物E2Eは未実行、失効rollbackの機能証拠は実SQLite/helperのtest。フロント成果物は変更なしなので再生成しない。

F14.patchを保存。新runtime dependencyなし/type importのみ。guard2statement追加、既存batchは同一1call、単発runはguard入りbatch1callへ置換。速度改善主張なし。review担当audit_dbへ固定Wの限定反証依頼中（再利用threadでfresh-context最終レビューではない）。review受入前にcommitしない。全体Goal/全domain監査/最終独立レビューは未完。


## 最終受入

限定レビュー記録F14-counterreview.mdを回収/照合、新規確定欠陥なし。レビューのD1検証懸念に対しF14-d1-guard.mjs/log/result.json（exit0）で同prepared再利用と前後guardのrollbackをローカルD1で実証。最後のguard後から物理commitまで絶対に期限を跨がないと主張しない。本番未実施。ローカル修復packetとしてVERIFIED、全体Goalは未完。元source不変で全PASSのdigest一致。4source/test filesのみcommit予定、PLANS/evidenceは別途未commitの継続台帳として保全。

Commit: df98ebebb6b134372d262fd32ba05ec66330998e。P→Wの4pathだけをstageしindex一致/diffcheck確認後にローカルcommit。状態INTEGRATED。PLANS/evidenceは保全、push/deployなし。

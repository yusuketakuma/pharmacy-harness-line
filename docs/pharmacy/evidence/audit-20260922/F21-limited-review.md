# F21 限定反証レビュー

ID: F21-LIMITED-20260922。担当 /root/audit_db。既存thread再利用でありfresh-context最終独立レビューではない。
P=d595215010ac956d5f697b7cc8083c26f3966787。Wは下記sha256で固定する未commit source。コード/Git変更なし。本記録のみ作成。

## 結果

新規confirmed bug・修復阻害findingなし。これは限定静的レビューであり全通知経路PASSではない。親のnear38/full verify:ci/compiled cron成功報告は独立した実行証拠として扱い、本判断の前提にはしない。

保持契約: tenant/account認可、clinical status/version/reminder_at、accepted→active監査、旧schema/row/API、送信retry key、既存migration不変。
新columnとpartial expression indexだけを追加。既存行はNULLで、旧INSERT/UPDATEはcolumn指定の既存契約を維持する。既存migration変更なし。bootstrap差分は新column/index、metaは028追加/count28、manifest期待値差分は028追記。
next-intake.tsの通常SELECTとdue SELECTは明示field列挙で新metadataをAPI/rowに出さない。
待機順はCOALESCE(checked,reminder_at)→reminder_at→id。有限のdue集合と前進するcron時刻の下で、50件の失敗/skipもcheckedを更新するため後続が進む。送信前に記録し、送信失敗で待機位置を占有しない。
metadata UPDATEはid/account/versionとaccepted|active、active tenant/account mappingを再検証。時刻はCASEで後退しない。clinical version/status/updated_atは更新しない。
accepted→activeは既存transitionExpectationを呼ぶ。event INSERTとstatus/version更新を既存batchで行い、監査失敗はcatchされdispatch対象にしない。metadataだけ先に進むことは再試行を後方へ回す意図に沿う。
tryの拡大範囲はmetadata writeとactive分岐。PRAGMAとdue SELECTは外側なので全体失敗を成功扱いにしない。個別write例外時はその行を返さない。
旧schemaではPRAGMAでcolumn不在を確認し旧ORDER/無metadata writeを維持する。旧schemaでstarvationが残ることはbriefの明示限界。
通知helperは未変更。retryKey next-intake:id とPHI-free template、sent/already_sent時だけreminded化を保持。

## concern / 限界

低・高確度: metadata UPDATE自体が特定の先頭50行で永続的に失敗すればcheckedが進まず、starvationは残る。今回の修復対象であるsender pause/failure/credential missingとは別のDB障害条件。失敗行をdispatchしない安全側の選択でありblockerとはしない。
低・高確度: metadataは排他claimではなく、同時cronが同じactive行を取得し得る。既存retry key/delivery dedupeへの依存は変わらない。並行cron全体のexactly-once保証を新たに主張しない。
未確認: remote D1での追加最大50 metadata writes/tickのlatency/cost、実負荷の公平性、無限流入・時計停止/逆行下の待機上限。schema PRAGMA障害は関数全体を失敗させる。

## 読取と検証

全文: 新028 migration、paired custom_080 test、notification-queue.test.ts、notifications.ts、F21-brief。
部分: next-intake.ts型/SELECT、transitionExpectation164–243、claimDue430–515。routesはAPI projection参照位置のみ。bootstrap/metaと既存manifest testsはdiffのみ。全sender/cron本体は今回未読。
既存テストコードで50→51、pause/failure/credential missing、復帰、accepted監査、旧schema、stale tenant/account/version/status、write失敗、時刻後退、migration前後行保持/旧UPDATE/FKを確認。実行はしていない。paired testは旧UPDATE互換を直接確認するが旧INSERT専用assertはない。新nullable列の静的確認と合わせた限定判断。
実施コマンド: git rev-parse HEAD、git diff/stat/status（対象限定）、rg、sed、cat、Pythonによるgit show/read_bytesとsha256計算。本記録以外の書込みなし。test/build/外部接続/実DB/spawnなし。長いdiff出力の省略部分は全文レビュー扱いにしない。
統合注意: 本記録のhashと最終Wを照合。変更後は影響分を再確認。親の実行証拠と合算する際もfresh最終独立レビューには数えない。

## P/W SHA-256

| 対象 | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/continuity/next-intake.ts | 1ad91a3cafc4816d0f16e1e8f60e9946275f27e997df8d55123536fa36b9cf64 | 66bafb2ba65e6d3cbc8284118bec5a527669353ee070bef0e9e3286efc9c3d86 |
| packages/db/bootstrap-meta.json | a80c1c6356a796504a45a62af2bd9b43f12f3f4f2074d925df88ccc3c0ca25a3 | 1290ce1b6e3d2b40cd156a1a0ef0a91a6c0acdb25078b99f0ab5ca81d3384a43 |
| packages/db/bootstrap.sql | ada9230a17c22f3cdc29fbf75742e11feb8ca5e7ebb826232553a0d07204cc9d | 57986d4233fdca5a048a3bf425c44a43ae4f2e09806fec15e958ff426613d52c |
| packages/db/test/bootstrap.test.ts | 67d956b9f48d681415a0fd4feeb88bc01da1d4342db4f2184315c5b45228a91b | 01a4c683dedd26944121c5308049348fb9664895a7272513a64d6fb1e8297787 |
| packages/db/test/custom_001_pharmacy_prescriptions.test.ts | c12318a0e47f2ef1af5a920541b0c3ff03b8d9d7eaa15d03d490fffd6e0e33b1 | 8c5c8a8c466a40cc3b56cdf7e8c2c387a62066daa4d6c11487a46f07aebb9cf7 |
| packages/db/test/custom_048_tenant_admin_audit_events.test.ts | afbee91397b23dd0cc63143d236247d4a504acac18dd96635315ae1a8ece7969 | 96a8db606cc6e7e491ecfebf5525d9b669b49ac51e826c01eb5692a55a4e6b09 |
| packages/db/test/custom_052_pharmacy_webhook_inbox_fencing.test.ts | 524936c9cd5c0ca5cc3ae5e208ad5fcbce3da2b31e6058f2ddb363ed8b7c8927 | dc1f155e5f705d300a50c9f7cba7f7a986377ecc8744ea947715dd12313f7704 |
| packages/db/test/custom_053_outgoing_webhook_deliveries.test.ts | b3196f947171a95777796961ba0849f70486a73b10c1dd467fae7fe8af7d08c8 | e3550016e0e235799d181b20e3a712835c2302298bcba00f094f3fc6ef6bc70b |
| packages/db/test/custom_054_pharmacy_cli_break_glass_sessions.test.ts | ee0ec7bd75a0f8862063305d6a4563655648880e650d31ac25ca8f5d2d628bb3 | 9dbd4ef9c68403362227d0c069cdeac0abbab0cb7d0601461fee22de81ee1424 |
| packages/db/test/custom_056_pharmacy_recovery_operations.test.ts | e5724f493a2c68d54d03bf65a3e7ada05ca4203bfeb9d612a94ef51045a4c194 | 4c070dea959a489219a5160230442cc3069c5418c9d20adacc37869f520c40e0 |
| packages/update-engine/test/upgrade-matrix.test.ts | 639d69041407bc172faff8dfafc593d622f718be1676348a96607f77238760df | 3212dcbe5a0e059ca31418e924f1134327f7c5a05741f7d02150df37d407b205 |
| apps/worker/src/custom/pharmacy/continuity/notification-queue.test.ts | 不存在（新規） | 52be9269ddda9a7edef5e6e935fd1eef12a92acd8e40bb033e0e6b735b5cc9e7 |
| packages/db/migrations/028_custom_080_pharmacy_continuity_notification_queue.sql | 不存在（新規） | c08939c3fa605fb141af0baf478b8749da307df38c78fdf7fa0339bdd26b426d |
| packages/db/test/custom_080_pharmacy_continuity_notification_queue.test.ts | 不存在（新規） | f6de93b3d2b5a6b0d391c445c8f465c3becf447b18f69d1b55e2c26dc6d60354 |

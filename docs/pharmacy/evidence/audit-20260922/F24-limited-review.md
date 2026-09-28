# F24 限定read-onlyレビュー

ID F24-LIMITED-20260922。担当 /root/audit_db。既存thread再利用、fresh最終独立レビューではない。
P=75cf0b78894dc92fa61620401bbd1b796b33c206。W全15pathsは下表。F24-input.jsonと実P/W SHA256一致。

## 判定・契約

新規修復阻害findingなし。有限のdue集合・前進するcron時刻の下で、claim成功時にcheckedを記録しreleaseで残すため、失敗/paused/credential missingの先頭50件が後続を永続占有しない構造。親PASS/性能結果を根拠にせず静的に確認。
既存15分leaseをcheckedと分離。checkedは既存claim UPDATEのSETに追加され、そのclaimの条件不成立なら同時に更新されない。timestamp CASEは後退防止、臨床期限/verification_status/reminder_due_atは不変。UPDATE回数追加なし、schema read1回追加。
claim WHEREはsubmission/account、verified、sentNULL、stalelease、valid_until、ready parent、capabilityを保持し、active tenant/account mappingを追加。tenant IDはdue SELECT由来で任意query authorityではない。旧schemaでもこの認可再確認は追加される意図的強化であり、SQLが完全に旧版同一とは表現しない。
releaseClaimはaccount/submission/claim timestamp条件を維持しcheckedを消さない。confirmed sent/already_sentのみsent stamp、他outcomeと例外はrelease。expired-review SELECT/helper呼出は差分なし、JST today計算不変。
旧schemaではcolumn不在をPRAGMAで判定し新ORDER/SET/bindを省く。旧schemaでstarvationが残る限界は明示済。public due rowは明示SELECT、新metadataなし。prescriptions/repository.ts953–954の公開validity SELECTも既存field列挙。
029はnullable TEXTのADD COLUMN/CHECKとpartial expression indexのみ。既存rowはNULLで既存column保持、旧named-column write互換。bootstrap差分は対応column/index、meta/manifest期待値は029追記。歴史migrationを変更する差分なし。

## 読取範囲

F24-input/brief全文、validity.ts差分と処理全体（初回長出力の末尾は170–218を再読）、029全文、validity.test.ts差分、queue test70–151の行動assert/競合注入、paired081 test40–57の移行前後比較/旧UPDATE/FK/CHECK。queue/paired fixture生成の全行は未精読。bootstrap.sql差分、manifest/metaはstat/inputおよびbriefの範囲であり全期待値差分を全文レビューしたとはしない。公開SELECTの直接field列挙を確認、全API/全repositoryは未読。
queue testsはpaused/failure/credential missing50→51、旧schema、送信復帰、tenant/account/claim競合、timestamp後退を確認する構成。pairedは旧UPDATEを直接確認するが旧INSERT専用assertはない。nullable追加の静的確認と分けて扱う。既存mock変更はPRAGMAをbusiness query位置集計から除外し、既存assert維持。

## 限界・除外

remoteD1 latency/cost/index利用は未確認。無限流入/時計逆行/DB障害下の待ち時間上限を保証しない。PRAGMA失敗は関数全体を失敗させる。expired review自身の別starvation可能性やclaim後の業務状態変更は本差分の修復完了に含めない。
既存sent stamp UPDATE後のchanges未検査、timestamp leaseの一般的な同時実行特性は差分外。新しいexactly-once保証を主張しない。metadataが未来へ不正更新された運用やraw INSERT VALUES全列指定の未宣言旧callerは未確認。

## 実施・統合

コマンドcat/rg/sed/git diff/stat、Python read_bytes/hashlib/git show、git rev-parse。全15hash一致。コード/Git変更なし、本記録のみ作成。test/build/benchmark/外部API/実DB/spawnなし。親near16/fullverify/compiledD1/性能は報告として受領、独立再実行していない。
final Wとprimary実行証拠を照合して統合。source変更時は影響分を再確認。fresh最終独立レビューには計上しない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/growth-loop/validity.test.ts | cbb5d4ffc14a6ef4d03a187680269d2aa281395f3e624968801dcffae062aeb1 | e780bc7891f2b4249e56b28d1a97d4b17547bbf700a23826db511f3b4b1c5a9c |
| apps/worker/src/custom/pharmacy/growth-loop/validity.ts | 14871604fa54bade3d2133e7d92ffbe3a08a2ea86646915d2b3d10bdcee49bd2 | bf7c1e468f7d54a2e10c3be26e62360ea6f289155b9ed210086a35f5a3561cb9 |
| packages/db/bootstrap-meta.json | 1290ce1b6e3d2b40cd156a1a0ef0a91a6c0acdb25078b99f0ab5ca81d3384a43 | d2bcdeb749fd1312821cfd21238778dd8fb26fe09d0fb08f6092479fa95db865 |
| packages/db/bootstrap.sql | 57986d4233fdca5a048a3bf425c44a43ae4f2e09806fec15e958ff426613d52c | 18616d78a92df58924aa414101a4fce91ca6fb5d6543735597eef947e676fdcf |
| packages/db/test/bootstrap.test.ts | 01a4c683dedd26944121c5308049348fb9664895a7272513a64d6fb1e8297787 | 25b3c9c0c2c14504af0274fc7b108a8b1bb03273ad2a11faaeff66dc924fbf36 |
| packages/db/test/custom_001_pharmacy_prescriptions.test.ts | 8c5c8a8c466a40cc3b56cdf7e8c2c387a62066daa4d6c11487a46f07aebb9cf7 | a593b6b8d629bf38af3f1e1b90cc92598d7d5472afb23d4fb13abf0b0624ce84 |
| packages/db/test/custom_048_tenant_admin_audit_events.test.ts | 96a8db606cc6e7e491ecfebf5525d9b669b49ac51e826c01eb5692a55a4e6b09 | adb1718c03e92d42077cf2557c1667e7613e0f56d06f096e40fbd57657620a2b |
| packages/db/test/custom_052_pharmacy_webhook_inbox_fencing.test.ts | dc1f155e5f705d300a50c9f7cba7f7a986377ecc8744ea947715dd12313f7704 | 1888ce52600efa030a01be62c19ce757b32ac8c360388cd3398ccac186834a86 |
| packages/db/test/custom_053_outgoing_webhook_deliveries.test.ts | e3550016e0e235799d181b20e3a712835c2302298bcba00f094f3fc6ef6bc70b | cc13fa5eb6595132345a9f9c5a34a42f2e730f052aed9d04de4f1bd409a1aab3 |
| packages/db/test/custom_054_pharmacy_cli_break_glass_sessions.test.ts | 9dbd4ef9c68403362227d0c069cdeac0abbab0cb7d0601461fee22de81ee1424 | 60d89583871586a4b57f9f29a2d16f7c5c2a2a6003785cc8efce57fe6299e0f6 |
| packages/db/test/custom_056_pharmacy_recovery_operations.test.ts | 4c070dea959a489219a5160230442cc3069c5418c9d20adacc37869f520c40e0 | 484a2b855464e7fc62eb7e91838607eb8048489e4cee3b75ab6f430e4ecb7ed4 |
| packages/update-engine/test/upgrade-matrix.test.ts | 3212dcbe5a0e059ca31418e924f1134327f7c5a05741f7d02150df37d407b205 | 3fbda2419f82669e56919e8d60979aefb475a72c7bbb783e54477f4fc7711874 |
| apps/worker/src/custom/pharmacy/growth-loop/validity-queue.test.ts | 不存在（新規） | d684915f52fbb14775c168df5510639e5acd06aaafd645c6d696647a9bc262a3 |
| packages/db/migrations/029_custom_081_pharmacy_validity_notification_queue.sql | 不存在（新規） | 67fc06808c0574d3231e34013f7d6336ece63062f712a7d92ed63f37707b439e |
| packages/db/test/custom_081_pharmacy_validity_notification_queue.test.ts | 不存在（新規） | 7643b49049cd7f1930ca68b533b963b76bc8018bce61bd75852c3ca95c6ddd82 |

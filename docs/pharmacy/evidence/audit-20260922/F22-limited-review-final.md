# F22-R1 修正後限定再確認

ID F22-LIMITED-FINAL-20260922。担当 /root/audit_db。既存thread再利用、fresh-context最終独立レビューではない。
P=24c336a50466d0afd8190576efb5a4ca529a880e。Wは下表、F22-input.jsonと全3path一致。前回F22-limited-review.mdおよび旧W記録は変更せず保持。

## 解決判定

F22-R1は指定更新Wで静的に解決。前回のunknown→end→stale retry→blocked上書き経路は、continuity_inactiveとreclaimedUnknownAttemptの組合せにより遮断される。新規修復阻害findingなし。テストの実行結果の独立再確認ではなく、コード・回帰testの限定反証判定。
reclaimedUnknownAttemptは初期false、既存attemptedのstale CAS成功時だけtrue。新規claim/failed再claim/既存sentには適用しない。unknownは以前のprovider結果を確定できない状態として保全される。continuity domainが終了/欠落/不整合の場合はproviderを呼ばずpatient_blockedを返し、reclaimed unknownならmarkOutcomeを省略する。初回未送信のinactiveはblocked記録を維持する。
新13番目testは実sender+UnknownOutcomeErrorでattemptedを作り、実end、16分stale、追加provider0/attempted保持、created_at25h後のreconciliation_requiredをassert。既存created_atを保持するためhorizonは再claimで延長されない。親near79PASSは報告として受領、私自身の実行とは区別。

## 保持契約と差分範囲

既存retryKey next-intake:<id>、account/friend/patient/parent JOIN、active/paused許可判定は前回レビュー済み構造を維持。新しいcontinuity_inactiveは内部enumのみでAPI/schema変更なし。一般blocked、既存patient guard、他通知、sent replay、paused retryは変更しない。domain停止以外までunknown保全の修正を広げていない。
初回inactiveはblocked、過去attemptedのdomain inactiveはattempted、pausedは既存patient_retryable、confirmed sentはalready_sentの既存分岐。追加sendを行って結果を確認する実装ではない。

## 読取範囲・実行

更新F22-input全文、senderのP→W全差分、dispatch-state.test.ts末尾（前回既読12casesと追加unknownケース）。前回のsender claim/final guard/markOutcome、通知caller、SQLite fixture読取を再利用。notifications.test.tsはW hashが前回と同じことを確認し重複レビュー省略。
実施: cat、git diff、tail、Python hashlib/read_bytes、git show、git rev-parseによる固定入力照合。本記録のみ作成。コード/Git変更、test/build、外部API/実DB、spawnなし。実行失敗なし。親full/build/runtime再実行は依頼時点で進行中であり本記録で成功を代弁しない。

## 限界・統合注意

最終DB read→provider呼出間の取消競合は残る。D1と外部providerの原子性は保証しない。
従来patient guard/一般blockedがunknownを終端化し得る広い問題は今回のdomain限定修復外。domain停止だけでF22-R1が再現する経路は解決したが、すべての停止理由についてunknown保全が完了したとは主張しない。
paused16分再試行と24h reconciliation制約は維持。自動再開の無期限保証なし。旧schema互換は028以前の対象schemaであり任意の古いschemaを保証しない。
最終採否はprimaryの更新Wに対するfull/build/runtime結果と照合して判断する。source変更時はW hashを更新し影響範囲を再確認。この記録をfresh最終独立レビューに数えない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/continuity/notifications.test.ts | 546dc32ecaa30e945c7ca89f993b377f2d478acf7cece9f2be0916cb5eeb77de | bee398a758b4d0c830f65f9a9ade39d088b2f61aeef0d47272c9081655d9ddab |
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | 72da8e899de33062f0aadfc29584f2cddf232239c58b1d47e9591536a860a339 | 5de92ac5a645ab468c0e17185ba99e8c5cf586d3ea4029f9a91dbcf15cda1914 |
| apps/worker/src/custom/pharmacy/continuity/dispatch-state.test.ts | 不存在（新規） | 01deb3c9601f5fd3e022a57e3b8f489dcaaeba1430dee1f3cf775f61e6b71e0a |

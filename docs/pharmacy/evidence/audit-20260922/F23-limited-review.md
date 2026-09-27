# F23 限定read-onlyレビュー

ID F23-LIMITED-20260922。担当 /root/audit_db。既存thread再利用、fresh-context最終独立レビューではない。
P=538de9f680ce5360aa00b59e5953382fafa56aa6。W下表、F23-input.jsonの全3path P/W SHA256と実ファイル/git showを照合、一致。

## 判定

指定4経路のunknown→blocked欠陥は更新Wで静的に解決。新規修復阻害findingなし。親near85/compiledD1 PASSを前提としない限定コード反証であり、全送信経路の安全性PASSではない。
recordBlockedのINSERT OR IGNOREは新規未送信だけblockedを生成し、既存UPDATEをfailed限定にすることでattemptedとsentを保持。account+retryKey scopeは不変。
postclaim/final patient/final dispatchのblocked分岐は、stale attempted再claim成功時のreclaimedUnknownAttempt=trueならmarkOutcomeを呼ばない。claimは既存のoutcome/時刻CAS成功時だけflagを立てる。初回claimとfailed再claimはfalseで従来のblocked記録を維持。sentはmarkOutcome自体のoutcome<>sent保護と既存already_sent分岐を維持。
provider呼出前にreturnすることは変わらず、unknown保全が送信許可に変換されない。既存continuity_inactiveはblockedへ統一されるが共通unknown保全が同じ分岐に入るためF22-R1を再導入しない。内部型のみ、公開API/schema/payload/retry key変更なし。
paused/operations_blocked/retryable、15分stale/24h horizon、created_atは不変。初期patient停止は従来通りhorizon検査前にpatient_blockedを返すため、照合情報を残すが自動照合を提供する変更ではない。
他messageにも同じ保全方針が適用される意図的な修復。capability/template選択、beta/patient/account認可、providerパラメータ、送信確定処理は変更していない。旧schema用の新column/table依存なし。

## 読取範囲・回帰確認

F23-brief/input全文。sender.ts全差分、390–442の早期gateとclaim準備、markOutcome/recordBlocked全call位置。前回F22で読んだclaim/reclaim/final gate/provider/unknown catchの実装を再利用。dispatch-state.test.tsの追加全6cases、sender.test.ts差分。全sender前処理/全proxy/全他messageのdomain helperを再監査していない。
新4casesは実UnknownOutcomeErrorでattemptedを生成し、実患者通知stopをinitial/postclaim/finalのread位置へ注入、またはfinal account disable。provider追加0、outcome attempted、created_at保持、FKをassert。positive2casesは初回とknown failure後のstopをblockedとして確認する。既存mock4箇所はSQL matcherだけをfailed条件へ変更しassertは維持。送信済み停止専用の新SQLite testはないがINSERT IGNORE/failed限定UPDATE/既存sent分岐から静的に保護を確認。

## 検証・限界・統合

実施: cat、git diff/stat、sed、rg、Python hashlib/read_bytes、git show、git rev-parse。全hash一致。本記録以外の変更なし。test/build/外部API/実DB/spawnなし。親のfullverifyは依頼時進行中であり本レビューで成功を代弁しない。実行失敗なし。長い出力の省略は全file既読と扱わない。
最終DB readとprovider呼出間の競合、provider結果の外部照合、24hを超えた自動解決は未確認/対象外。既存attemptedが本当に外部到達したかをDBだけで区別できないため保守的に全attemptedを保持する。停止後もattemptedを残すことは未送信断定より安全な意図的挙動。
failedの意味が将来unknownまで含むよう変更された場合は本保全条件を再評価する必要がある。現在はUnknownOutcomeErrorのcatchがfailed化しない既存契約に依存。
最終W/hashとprimaryのfull/build/runtime結果を照合して統合する。fresh最終独立レビューとして数えない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/continuity/dispatch-state.test.ts | 01deb3c9601f5fd3e022a57e3b8f489dcaaeba1430dee1f3cf775f61e6b71e0a | 0742fd0896eb1f82349a1d607bc0b8ff804a356ed7fb6c1d1245396cc4837a6d |
| apps/worker/src/custom/pharmacy/growth-loop/sender.test.ts | a337f7bf7f4897206a844c9569b7d6873ce2bbc52530c89dfd1a3468326cf545 | 1ff5767a5dee5aeb397c147a772cf3857c4bb49ede1e22ba836e9e4c8f78b91c |
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | 5de92ac5a645ab468c0e17185ba99e8c5cf586d3ea4029f9a91dbcf15cda1914 | f8887313996f274de4bc2f7676b954955fe6c2b3f8dfe3ac7286c98820bb4d3f |

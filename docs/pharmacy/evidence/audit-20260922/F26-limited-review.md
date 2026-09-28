# F26 限定read-onlyレビュー

ID F26-LIMITED-20260922、担当 /root/audit_db。既存thread、fresh最終独立レビューではない。
P=10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e。W全3hashを入力と照合、一致。

## 判定

逐次の未送信保留→25h後再開とprior unknown保持の修復方針は妥当。下記並行所有のconcernが残るため、並行実行を含めたunknown保全PASSとはしない。新しい実行再現済みfindingはなし。
postclaim/final patient retryableは初回・knownfailedの場合だけfailed、恒久blockedはblocked。prior attempted再claimはどちらも上書きしない。final tenant pause/patient retryable/operations blockも同じ規則。全分岐provider前returnを維持。private validity_retryable削除は内部統合でF25の挙動を維持する。
claim前gateは変更せずledger作成なし/既存recordBlocked保全を維持。sentは既存markOutcomeのsent除外とalready_sentで保持。attemptedの15min/24hとcreated_atは不変。未送信が確実な逐次failedだけ既存failed retry経路を使う。API/schema/payload/retrykey/認可条件変更なし。

## Concern F26-R1: 古いclaim所有者による別attempt上書き

重大度中候補、確度: 静的順序は高、実行再現未実施。Aが新規claim（reclaimedUnknownAttempt=false）後に15分以上遅延、Bが同keyのstale attemptedを再claimしproviderで結果不明、Aが一時gateへ到達すると、markOutcome(account,key,outcome<>sent)はBのattemptedをfailedへ変更できる。ローカルbooleanは現在DB行のattempt所有を証明しない。failedになると後続はunknown horizonとは別のretry経路を使う。
markOutcomeの所有CAS欠落は既存処理にもあるが、今回追加した共通failed書込みも影響を受ける。正常な短時間の逐次処理では成立しない。worker実行時間やlease超過を不可能にする根拠は今回確認していない。
最小再現候補: A final gateのDB readをbarrier、DB occurred_atをstale化してB実sender+UnknownOutcomeError、A gateをretryableで解放、Bのattempted維持をassert。claim timestamp/attempt token等の所有CASで古いAの結果更新を拒否する方向。コード修復は行わない。primaryへ通知済み。

## 読取・テスト保全

F26-brief/input、paused-resume-investigation全文。sender差分全文、sender.test/dispatch-state.test差分全文。既読sender claim/markOutcome/provider/unknown catchを再利用。
SQLite4casesはcontinuity/tenant × initial/priorunknown、25h復帰を比較。unitはpostclaim/finalpatient/finalscope beta/operations × known/unknownを比較しfailed bind値もassert。既存16min testのattempted→failed期待変更は今回意図する未送信保留分類変更であり、未知結果testを緩めていない。並行所有上記caseは追加testsで未検証。

## 実施・除外・統合

cat/git diff、Python read_bytes/hashlib、git show/git rev-parseのみ。全3hash一致。本記録以外の変更なし。test/build/外部/実DB/spawnなし。親near72は報告、独立実行でない。RED/full/buildは依頼時進行中。fresh最終レビューに数えない。
最終read→providerの原子性、remoteD1/実送信、全通知domain、25h超unknownの外部照合は範囲外。primaryはF26-R1の到達性/再現を判断して最終受入に反映。逐次PASSを並行unknown保全へ拡張しない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | 3bfcde9eb5fd23e94eaa02e9a92902e63ccd8f302dee15a15f16f78f22d1761e | 33363a5c9f032a4f828aa2712b837c3ef53d56a463f44143da89be4330364e41 |
| apps/worker/src/custom/pharmacy/growth-loop/sender.test.ts | 1ff5767a5dee5aeb397c147a772cf3857c4bb49ede1e22ba836e9e4c8f78b91c | 1a7bf3f6515106b34b436c8d2026eb9549731fb865ff1ce66cc2477d64bf60d3 |
| apps/worker/src/custom/pharmacy/continuity/dispatch-state.test.ts | 0742fd0896eb1f82349a1d607bc0b8ff804a356ed7fb6c1d1245396cc4837a6d | c2fc4cdd7251f8c778e006d9fe88f15d3b4aa0999750f459b0ece107e957200d |

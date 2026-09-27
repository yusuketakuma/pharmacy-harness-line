# F25 限定read-onlyレビュー

ID F25-LIMITED-20260922。担当 /root/audit_db。既存thread再利用、fresh最終独立レビューではない。
P=fa43ab1e53a60e6154ad528a7ee2453e0774cbf4。Wは下表、F25-input.json全2pathと実hash一致。

## 判定・保持契約

新規修復阻害findingなし。指定の最新validity状態再照合は静的に確認。親RED/near117/compiledD1 PASSを本判断の前提にしない。
既存prefixとgenericDateのsuffix一致でsubmissionIdをsliceし、値はSQLbind。wrongprefix/date/missingはNULLまたは未一致のLEFT JOINからCASE0へ進みproviderを止める。新しい任意ID入力は追加しない。submission/account/friend、validity account/submission、patientlink account/owner/submissionを照合する。patientIdのIS比較でlegacy no-link+NULL inputだけNULL一致を許し、旧patient付きinputのlink解除は拒否。
verified/ready、current valid_untilとpayload date一致、fresh実時計のJSTtoday以内、due時刻到来、claim非NULL、sentNULLを同finalSQLで判定する。古いprocessor nowだけでは期限切れを通さない。
CASE不成立はpatient_retryable。providerを呼ばずattemptedを残し、一時unverifiedからの再確認後に同keyで15分stale retry可能。初期candidateのblocked終端化を再導入しない。F23 unknown保全、confirmed sentのalready_sent、24h horizonは未変更。無期限の自動復帰は保証しない。
追加JOINとplaceholderはvalidity messageだけ。他messageはconstant1 aliasで新validity tablesへ依存しない。placeholder順はcapability→validity CASE4→既存beta SELECT→patient JOIN→continuity JOIN→validity submission JOIN→既存followup/WHEREのbind順に一致。公開API/schema/payload/date規則変更なし。029 metadata非依存で直前schema互換。

## 読取範囲

F25-input/brief全文、sender P→W全差分、validity-dispatch.test.tsの95行以降の全行動ケース（先頭fixture全体は未精読）、testケース/assertの索引。以前のF23/F24で読んだsender claim/final guard/retry、validity processor/releaseを再利用。その他通知domain全体や全SQLを新たにレビューしていない。
回帰はcurrent/oldschema正常+sent replay、実saveによるclaim後/最終read訂正、closed/cancelled/unverified/JST expiry/link解除、legacyNULLlink、missing/foreign/wrongdate/prefix、UnknownOutcomeError保持、実再確認16分後retryをassert。JS時計固定/復元の存在を確認。fixture全制約と全SQL branchの実行成功は親の実行証拠事項。

## 限界・除外

claimは非NULL確認であり、特定callerのclaim token一致や15分以内のfreshnessを最終SQLで証明してはいない。既存caller契約にclaim tokenがないため、この変更を排他所有の最終証明と解釈しない。送信重複抑止は既存ledger/retrykeyへの依存が残る。
最終SQL→provider間の競合、provider成功後のstamp競合は未解決。期限訂正で旧keyがattemptedのまま残る場合の外部照合、自動復帰の24h制約は対象外。
wrongrefsもretryableになるため未送信attemptedが残り得るが、外部送信はしない。すべてを恒久blockedへ変えると再確認後復帰を壊すため一律終端化は提案しない。
旧schemaは029前のvalidity domain schemaを指し、任意の古いDBをsupportする主張ではない。legacyNULLpatient許可は既存互換であり新しい患者認可拡張として扱わない。

## 実行・統合

実施cat/git diff/stat/rg/sed、Python read_bytes/hashlib、git show、git rev-parse。P/W全2hash一致。本記録以外の変更なし。test/build/外部API/実DB/spawnなし。失敗なし。親fullverifyは依頼時進行中であり本記録で成功を代弁しない。
最終source hashとprimary実行証拠を照合して統合。変更後は影響分再確認。本記録をfresh最終独立レビューに計上しない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | f8887313996f274de4bc2f7676b954955fe6c2b3f8dfe3ac7286c98820bb4d3f | d317db2f2e1a94e5398a01f5eaf63b01212c1df9ad4269077bfe9fd94edb6d07 |
| apps/worker/src/custom/pharmacy/growth-loop/validity-dispatch.test.ts | 不存在（新規） | 3ecd91910b56ab62f14f503dcf102e027cdf1208e2507f79762221b68f238bc2 |

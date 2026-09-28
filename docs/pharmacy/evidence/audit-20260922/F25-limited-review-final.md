# F25 更新W限定再確認

ID F25-LIMITED-FINAL-20260922。担当 /root/audit_db。既存thread再利用、fresh最終独立レビューではない。
P=fa43ab1e53a60e6154ad528a7ee2453e0774cbf4。更新W全2hashをF25-inputと照合、一致。前回F25-limited-review.mdは消さず保存。

## 判定と訂正

更新Wで25h再確認後の未送信通知を再開できる構造を確認。新規修復阻害findingなし。前回記録の「未送信不適格もattemptedを残し24h制約を受ける」は旧Wの挙動であり、本追補が優先する。前回はこの限界をblockerとして採択しなかったが、primaryの追加REDが再開要件違反を具体化したため修正対象となった。
private validity_retryableを一般patient_retryableから分離。新規claim/既知failed再claimでprovider未呼出ならfailedへ遷移し、同keyで後日再試行可能。既存attemptedのstale再claim時はreclaimedUnknownAttempt=trueなのでfailedへ上書きしない。provider結果不明の24h照合契約を弱めず、未送信が確実な分だけ再開を許可。
新分岐はprovider呼出より前にreturnし、sentはmarkOutcomeのoutcome<>sent条件で保全。date/account/friend/patient/current validity SQLは前回構造を維持。一般patient_retryable、continuity、他通知、既存paused/horizonは変更なし。enumは内部型のみで公開API/schema/retrykey変更なし。
known failed分岐は従来horizon検査なしで再claim可能。今回の未送信failedはこの既存安全なretry経路を使用する。送信結果不明attemptedは依然created_atベースのhorizonが適用される。古いcreated_atで新しい送信が結果不明になれば保守的に早く照合要求となり得るが、危険な自動再送へ弱めてはいない。

## 読取・検証

更新F25-input、sender全差分の変更分とvalidity_retryable分岐/直後provider呼出、test末尾unknown保持と16分/25h実再確認のparameterized case。前回scope/SQL/旧schemaレビューを再利用。testは25h後も期限内に設定しており、期限を延長して通すものではない。既存unknown caseはattempted保持を継続確認する構成。
cat/git diff/tail/sed、Python hashlib/read_bytes/git show/git rev-parseを実施。全2hash一致。本記録以外の変更なし。test/build/外部API/実DB/spawnなし。親近傍PASSは報告として受領、fullverify/artifactは依頼時進行中で成功を代弁しない。

## 限界・統合

既存claim所有の非NULL判定、最終read→provider競合、provider成功後stamp競合、全通知の結果不明自動照合は前回同様未解決/範囲外。fresh最終独立レビューには数えない。最終source hashとprimaryの更新W全verify/artifact証拠を照合して統合する。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/worker/src/custom/pharmacy/growth-loop/sender.ts | f8887313996f274de4bc2f7676b954955fe6c2b3f8dfe3ac7286c98820bb4d3f | 3bfcde9eb5fd23e94eaa02e9a92902e63ccd8f302dee15a15f16f78f22d1761e |
| apps/worker/src/custom/pharmacy/growth-loop/validity-dispatch.test.ts | 不存在（新規） | 4a6b7331f2bdf0995315ef6b037f71d7e8fe8c3bcf3c36af5c124d445697dd78 |

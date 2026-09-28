# F29 限定read-onlyレビュー

ID F29-LIMITED-20260922、担当 /root/audit_db。既存thread、fresh全体独立reviewではない。
P=797a7cbc56e857a63b104a68cb2bf343bdb8f93d、W全3hash下表。入力と実ファイルP/W一致。

判定: PT-02の対象raw body/transport/parser例外伝播は静的に解消。新規修復阻害findingなし。template限定であり稼働中薬局の漏えい被害や署名認証完了を主張しない。
WebhookはJSON parseだけを維持しbodyをlogへ渡さず、catchも元例外を渡さない。成功200/received、不正JSON400/固定error、health/404は不変。元handlerはbodyを業務処理に使用していなかったため今回body変数削除で処理を省いていない。署名検証/実処理TODOは未解決だが別件。
MyServiceClientはfetch rejectを固定errorへ変換し、non2xxはbody.text/jsonを読まずstatusだけをerrorへ含める。body.cancel rejectionはcatchで吸収しstatusを保持。bodyなしはoptional chainで通過。成功JSONはawaitしてparse/read rejectionも固定errorへ変換し、成功値/header/URL/公開method signatureを保持。error causeにraw例外を格納しない。
consumer sync/notifyのconsole.error、MCP String(error)に到達するMyServiceClient由来errorは固定文言/statusだけ。consumerが扱うSDK由来error・customer IDログ・成功payloadのPII・prompt injection・宛先対応は今回の全保証外（前回templateレビュー再利用）。

読取: F29-brief/input全文、index/external-api差分全文、新scripts/plugin-template-privacy.test.ts全文。直接consumerは前回templateレビューの既読を再利用。新testsは正常/不正webhook、http/json/network failure、成功JSON/header、MCP lookup errorの7cases。短sentinelがparser断片を検出する構成。non2xx text未読とcancel呼出assertあり。cancelがrejectする専用testはないが.catchで静的確認。cancel promiseが解決しない異常streamで待ち続ける可能性はtimeout保証として未検証、以前のbody.textにも待機があったため新規確定bugとしない。

実施cat/git diff/stat/rg、Python read_bytes/hashlib/git show/git rev-parse。P/W3一致。本記録以外変更なし。test/build/外部通信/実データ/spawnなし。親旧P6FAIL1PASS→W7PASSは報告、独立再実行ではない。全verify/compiledWorker/MCPは依頼時進行中で結果を代弁しない。
最終W hashとprimaryの検証/成果物証拠を照合して統合。fresh全体独立reviewへ計上しない。成功payloadの許可や本番Webhook採用の承認を付与するレビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| packages/plugin-template/src/index.ts | bacaac3f1eb4d28d658f2a27ad9d245eee5f7e62604727f582d0718e4a691617 | 607a260301822a1bc3ac5581e89a0eeaa01c182ebd44064c82da40caf4de3c1e |
| packages/plugin-template/src/external-api.ts | fe93b3e0b0d4ddbfc0c4a52dde40ca486701c58b9b2dd26d6519e2da14059ba7 | ba4a0bf9e1cdb8939a43daf00de4c52942e5fece0d506e85d35504fca4283708 |
| scripts/plugin-template-privacy.test.ts | 不存在（新規） | 3d3a52f3a9875a486b42094134f7f47ed0840f68cda302b870e6ebce53c46c34 |

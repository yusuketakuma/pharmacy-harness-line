# F29 FIX — 雛形の受信/上流本文をログへ転載しない
P=797a7cbc56e857a63b104a68cb2bf343bdb8f93d、primary/dev、RUNNING。PT-02 confirmed/P2、template限定、実薬局mount/被害は未確認。書込plugin-template/src/index.ts、external-api.ts、新scripts/plugin-template-privacy.test.ts。
受信Webhook JSON本文/parse Error、上流non2xx本文/JSON parse Errorをconsole/例外へ出す経路をsentinelで再現。成功payload/HTTPstatus/health/404/署名TODO/SDK mutation未実装は維持、公開入力/出力APIや実provider認証を追加しない。ログ/例外は固定分類とHTTPstatusに限定する。raw fetch rejectも低信頼errorとして固定化。
Acceptance: Webhook正常/不正JSONのログ非転載、API非2xx/不正成功JSON/network errorの非転載、成功JSON/header不変、MCPtoolへの例外非漏洩。旧P RED→GREEN、root既存tooling/fullverify、Worker/MCP build/import runtime、限定review、isolatedpatch。既存SDK由来エラーや全template運用設計/通知宛先は本修復の全保証に含めない。

RED: initial長sentinelではJSON parserの一部転載を検出できず4FAIL3PASSだったため、短い合成PHI_729に変更し、invalid JSONの断片露出も捕捉。実装変更前F29-red.log6FAIL1PASS、変更後F29-green.log7PASS。HTTP非2xxはbody未読/cancel、成功header/JSON維持、MCP lookup error含む。global fetchとconsole/環境はtestごと復元、実外部呼出なし。
実装はWebhookログ固定、外部client fetch/json reject固定、non2xx statusだけ保持しbodycancel失敗はbest-effortで元status保持。成功JSONはawaitしてparse exceptionもcatch対象にする意図的privacy差分。fixture変数はsynthetic、実secretsなし。

生成物追補: tracked dist-mcp/index.jsにも旧raw body例外が残るため、既存build:mcpによる再生成を第4の変更pathに含める。直接編集なし。tracked P 737017B→W 1338574Bは既存ソース/依存の未反映を含む。Pを同じinstalled dependenciesで隔離再生成した1338355BとWの差分はexternal-api catch/error処理43行のみ（+219B）。lockfile/manifest不変、provenance JSON/source delta patch参照。既存生成物の互換性を全保証せず、実stdio list/lookupの合成smoke済み。

互換追補: 旧tracked/current tools/list実stdio比較でinputSchema.additionalProperties:falseの省略を検出（exact比較FAIL）。required/type/enum/extra input6組は旧新同じ到達結果。再生成に伴う公開宣言差を放置せず、example-tool.tsで既存registerTool APIへ登録を移し、Zod objectのJSON Schema metadataにadditionalProperties:falseを明示する。実parseのunknown-stripは維持。これはgenerated refreshに必要な互換修復であり、未知keyをrejectするstrict化やvalidator緩和は行わない。新sourcepath追加、schema生成/parse回帰test、exact compiled old/current契約比較を再実行する。

INTEGRATED 34b32dfd1d0d2447b7bb324a8e4ef4f5704169b0。最終5paths isolatedpatch/hash/限定review親読取、8tests/typecheck/build/runtime成功。旧compiled tools/list exact一致と6validation一致でschema差解消。generated whitespace1件diffcheck exit2は正規生成物内のtemplate literalとして保持。詳細F29-result.json。

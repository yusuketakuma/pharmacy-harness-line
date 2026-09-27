# plugin-template 限定静的調査

ID PLUGIN-TEMPLATE-20260922、担当 /root/audit_db、既存thread。fresh全体独立reviewではない。
P=3be2dbf1bed931fbf98cca4e40f934fce2058ba4、W=読取source（下表）。source/Git変更なし。本記録のみ作成。

## 位置付け・保持契約

packages/AGENTSとREADMEはフォーク元の雛形。package private:true、外部APIはexample.com stubで、既存薬局本番にmountされる根拠なし。READMEはコピー→実装→deploy手順を示す。したがって稼働中薬局の脆弱性と同一視しない。
package scriptsにinstall/preinstall/postinstall/prepare hookなし。build/dev/deploy/build:mcpは明示実行script。wranglerは毎時cron、設定はplaceholder。依存のtransitive lifecycleは未監査。
cronは外部customer読取→SDK tags/metadata更新→scenario通知。Worker HTTPはhealthとwebhookのみ。MCPはstdioで2tools、権限は起動環境のcredentialに依存し独立user承認/認可層なし。LINE APIへ直接送らずSDK/Workerへ委譲。tenantIdはWorker/MCPとも渡す。

## Findings

PT-01 confirmed documentation bug、重大度低、確度高。READMEのMCP env例と環境変数表はLINE_HARNESS_TENANT_IDを欠くが、mcp-server/tools/example-tool.ts getClientsはgetEnvOrThrowで必須化する。そのまま掲載例に従うと両toolはMissing required env varで停止する。mcp-server/index.ts冒頭例も同じ欠落。wrangler.tomlにはtenant placeholderがあるためWorker経路とは区別。最小修復候補は両MCP例とREADME表へ必須tenant IDを追記。実行再現なし。

PT-02 confirmed source logging boundary violation（template限定）、重大度中候補、確度高。src/index.ts POST /webhookは署名検証TODOのままrequest.jsonをconsole.log(JSON.stringify(body))。任意送信者のbodyがログに入る。外部イベント処理はTODOでSDK mutationを呼ばないため認証迂回による本番操作とは主張しない。rootのPHI/PII保護契約、外部医療等サービス統合の例に対して本文ログは危険。src/external-api.tsは非2xx本文をErrorへ含め、sync/notify catchのconsole.errorやMCP String(error)へ伝播する。実PHI漏えいは未確認。本文非出力/固定error、実装前webhook拒否が候補。

PT-C1 concern: MCP send_myservice_notificationはfriendIdとcustomerIdを独立入力で受け、appointment detailsをcustomerIdから選びfriendIdへ送る。宛先と外部customerの対応を検証しない。z.stringのみでID形式/長さも未制限。広い権限を持つoperator用exampleか自動通知かの契約が曖昧。SDK sendTextToFriend→friends.sendMessageがmanual headerを付けることを直接確認。MCPの手動依頼ならmanual経路は妥当だが、無人の予約通知として使うとmanual扱い/自由本文に依存し薬局approved templateとは別。production認可迂回とは断定しない。
PT-C2 concern: ensureTagAddedScenarioはactive scenario作成→addStep。addStep失敗後はname一致により次回早期returnし、空scenarioのままtag dedupが働く可能性。cron通知例は将来の予定向けtag解除をコメントで要求するが自動解除なし。exampleの未完成箇所として明示すべきであり正式薬局cronへの到達は未確認。
PT-C3 concern: getCustomer(id)はURL pathへ未encodeで挿入。../やqueryによる外部API内path選択の余地。hostは定数なので任意host SSRFと断定しない。外部responseはruntime schema検証せずMCPにname/email/metadataを返す。prompt injection可能なデータだがeval/shell実行は対象sourceにない。

## coverage / 未確認

読取: package.json/README/wrangler/tsconfig2、src index/external-api/sync全文、notify主要全文（長出力に切断箇所あり）、MCP index/reexport全文、example-tool入口と両handler。README含む初回出力の切断部は全面既読と扱わない。直接依存はSDK workflows sendTextToFriend、friends sendMessage/manual、Worker friends manual gate所在。SDK全HTTP認可、scenario backend、実deployment/publisher、依存audit、外部API/実credentialsは未確認。
package READMEにも薬局本番対応・PHI safeの保証はない。READMEにdeploy手順があることだけで現production利用を推定しない。汎用tags/scenariosの薬局制限を回避する提案はしない。

## コマンド・実行

git rev-parse、rg --files/rg -n、cat/sed、git ls-files、Python read_bytes/hashlib。package内AGENTS検索は該当なし(exit1)。secret/.env/実データは未読。test/build/install/deploy/外部通信/spawnなし。成果は静的調査のみ。
統合: PT-01とPT-02をtemplate限定で採択判断、その他は契約/実利用を確認するまでconcern。fresh全体reviewに計上しない。

## 対象SHA256

| path | W SHA256 |
|---|---|
| packages/plugin-template/README.md | 85d85b522c149818a6d3b7e00528ab01f1f1642d499edf9dd7dc94078c198f4e |
| packages/plugin-template/dist-mcp/index.js | 1a437bc07a447a28413378c6de0e8d738b710565c2d2cac630ccc23b937a2cc2 |
| packages/plugin-template/mcp-server/external-api-mcp.ts | 3995428a406a22905f201b5628f56354de217bbe3e0ab5f1f329880ab0e1135f |
| packages/plugin-template/mcp-server/index.ts | d481dc77fcddb5436158808cb5045904bd4852ab96e0b2ffe6776ed7e3d05628 |
| packages/plugin-template/mcp-server/tools/example-tool.ts | 231fbe12d8297c93ef1966275909abbcbe87b4ddbb2630af6c6aad653925d633 |
| packages/plugin-template/package.json | 63fdbbfbbba3a292976bd61661a91f005b9273ad4dbf41eb2e574f65daa7c112 |
| packages/plugin-template/src/external-api.ts | fe93b3e0b0d4ddbfc0c4a52dde40ca486701c58b9b2dd26d6519e2da14059ba7 |
| packages/plugin-template/src/index.ts | bacaac3f1eb4d28d658f2a27ad9d245eee5f7e62604727f582d0718e4a691617 |
| packages/plugin-template/src/notify.ts | a8bfa918be90cffbbece00bbef19fc1bb9dae808b527fef5e8aa39f717b73f41 |
| packages/plugin-template/src/sync.ts | c92fa95b65098de66ec9f348c2b7cddeff14dc03b419089b6272a38a06f9b2f9 |
| packages/plugin-template/tsconfig.build.json | 1c83877cf49301ce786c50755d1924f136a07a256041bff79c6667fa627a8fdd |
| packages/plugin-template/tsconfig.json | bc1cdc067195c7135ace0d4fdf256a500a59c2c5495e12cd0d4321ead1e292b7 |
| packages/plugin-template/wrangler.toml | ecabc135538537edc4e20b3f657b280058e72ef6b99ea202a7899558ebf29ba5 |

# F29 最終更新限定レビュー

ID F29-FINAL-20260922、担当 /root/audit_db。既存thread、fresh全体独立reviewではない。
P=797a7cbc56e857a63b104a68cb2bf343bdb8f93d、最終W全5hashをinputと実ファイル/git showで照合、一致。旧review/失敗記録は保持。

判定: 新規修復阻害findingなし。旧compiled tools/listからadditionalProperties:falseが消える契約差は、正本tool登録変更と正規再buildにより解消したと判断する。metadataは未知keyをhandlerへ通すpassthroughではない。z.objectの既存string/enum/optional/descriptionを保持し、JSONSchema出力へfalseを付与する。runtimeはZod objectのunknown-stripを維持し、旧宣言と旧実挙動の組合せを維持する。strict objectへ変えて旧追加key入力を新たに拒否する修復ではない。
ローカルinstalled MCP SDKのregisterToolはconfig.inputSchemaを登録、validateToolInputはnormalizeObjectSchema→safeParseAsync→parseResult.dataを使用する。独自validation bypassを挿入していない。handler本体/公開tool名/descriptionは差分なし。
新testは登録fakeをregisterToolのconfig形へ更新し、既存lookup error assertを維持。追加testは両schemaのadditionalProperties:false、required拒否、unknown key除去を実schema.parseで確認。fakeはMCP実登録validationを代替しないが、親の旧/current実compiled比較6inputケースとexact tools/listログがその別証拠。

生成provenance-finalは同depsP再生成→W84行だけ（privacy requestとtool登録）を示す。source-delta-final該当全変更を読取り、今回sourceに対応。artifact.jsonは最終bundle1338902B/hash611a49…でinputと一致、outbound0/runtime exit0を記録。最初にF29-artifact-final.jsonを探索したが不存在、実正本は更新F29-artifact.jsonとfinal.logだったため訂正して読取。
旧巨大tracked bundleとの差を全dependency互換PASSとしない。最終実compiled tools/list exact structural equalityと6validation一致は読み取ったログ上PASSで、本reviewの再実行ではない。初期fullverifyはprivacy source版で、最終登録変更は親typecheck/test/build/runtime検証として分ける。

coverage: input、toolsource差分、privacy test末尾（fake/追加test）、source-delta-final、provenance-final、contract-final.log、artifact.json、installed SDK validate/registerの必要部分。前回privacy source/consumer reviewを再利用。全bundle/depsや実外部通知は未監査。
実施cat/git diff/tail/sed/rg/ls、Python hash/read_bytes/git show。source/Git変更なし、本記録のみ作成。test/build/runtime/外部/実データ/spawnなし。既存trailing-whitespace警告は前追補どおり生成コードの一部で、このreviewで手修正しない。
契約差を許容した前追補案は最終方針ではなく、正本で旧宣言を保持する本変更が優先。最終Wと検証証拠を照合して統合しfresh全体reviewには数えない。署名TODO/SDK由来エラー/宛先整合などPT別件の未確認は未解決のまま。

| path | P SHA256 | W SHA256 |
|---|---|---|
| packages/plugin-template/src/index.ts | bacaac3f1eb4d28d658f2a27ad9d245eee5f7e62604727f582d0718e4a691617 | 607a260301822a1bc3ac5581e89a0eeaa01c182ebd44064c82da40caf4de3c1e |
| packages/plugin-template/src/external-api.ts | fe93b3e0b0d4ddbfc0c4a52dde40ca486701c58b9b2dd26d6519e2da14059ba7 | ba4a0bf9e1cdb8939a43daf00de4c52942e5fece0d506e85d35504fca4283708 |
| scripts/plugin-template-privacy.test.ts | 不存在（新規） | e8760fdc213faf0e649dd7a06d4a384522ff6698932d153012074ea4045cad6b |
| packages/plugin-template/dist-mcp/index.js | 1a437bc07a447a28413378c6de0e8d738b710565c2d2cac630ccc23b937a2cc2 | 611a49b7c7cfc91ebbbfad3624e96be6ea5bd499f9d67e92052ef009c60b0a09 |
| packages/plugin-template/mcp-server/tools/example-tool.ts | 231fbe12d8297c93ef1966275909abbcbe87b4ddbb2630af6c6aad653925d633 | 779aa2d1ab3d32b7635d4dd627aef2d6d970df1eef2d06729885966b29376891 |

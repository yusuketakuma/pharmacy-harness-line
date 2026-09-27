# F29 生成物限定追補レビュー

ID F29-GENERATED-20260922、担当 /root/audit_db。既存thread、fresh全体独立reviewではない。
P=797a7cbc56e857a63b104a68cb2bf343bdb8f93d。更新W4hash実ファイル一致、lockfile hashもprovenanceと一致。source3pathsは先のF29-limited-reviewから不変で結果を再利用。

判定: tracked実entry dist-mcp/index.jsを正規build:mcpで再生成して含める判断に異論なし。これを省くとREADMEの直接node起動が旧raw本文errorを使う。正本sourceを修正後に公式scriptで生成する手順であり、生成物直接編集ではない。再生成実行自体はprimaryの記録に基づき、本reviewで再実行していない。
trackedP737017B→W1338574Bの大差はF29だけの変更ではない。same installed depsの再生成P1338355BとWの43行/+219B差分はMyServiceClient.requestのfetch/json固定error、non2xx status-only/cancelで、source修復に対応。実W35670–35710でも同じ処理を確認。W末尾はMcpServer登録→StdioServerTransport接続→mainで実entry形を保持。
lockfile/package manifestに差分なし。既存tracked artifactと同じ依存runtime挙動まで保証することはできない。same-deps source deltaで差を説明できることと、古い配布bundleの全互換性は別。

artifact記録はWorker health/404/webhook、MCP実stdio tools/listとsynthetic503 lookup、outbound0のPASS。W bundle hashはartifact JSONとinput/provenanceで一致。全MCP tool/send成功経路・全SDK依存挙動、旧Node/CI Node22、実外部サービス互換は未確認。この限定smokeを全面互換PASSへ拡張しない。

whitespace: git diff --checkはdist-mcp/index.js14428の空白行1箇所を報告。14420–14434を読取り、依存コードがdoc.writeのtemplate literalで生成するJavaScript中の空白行と確認。識別子/文字列payload/API値ではないが、template literal bytesの一部なので生成物を手でtrimして修正しない。check警告は未解消として明示し、正規生成とexact hashを優先する。実害あるsyntax問題をこの行からは確認しない。

読取: provenance JSON、source-delta.patch全43行、artifact JSON、brief追補、input、W対象request部分/末尾/whitespace周辺のみ。巨大bundle全diff/全dependency codeは未読。既存自作sourceレビューは前回結果再利用。
コマンドcat/tail/sed/git diff --check/git diff --name-only、Python read_bytes/hashlib/git show。警告は上記1件、hash照合成功。code/Git変更なし、本記録のみ作成。build/runtime/test/外部/実DB/spawnなし。新規findingなし、配布entry互換の残余制約を保持して統合。fresh全体独立reviewに数えない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| packages/plugin-template/src/index.ts | bacaac3f1eb4d28d658f2a27ad9d245eee5f7e62604727f582d0718e4a691617 | 607a260301822a1bc3ac5581e89a0eeaa01c182ebd44064c82da40caf4de3c1e |
| packages/plugin-template/src/external-api.ts | fe93b3e0b0d4ddbfc0c4a52dde40ca486701c58b9b2dd26d6519e2da14059ba7 | ba4a0bf9e1cdb8939a43daf00de4c52942e5fece0d506e85d35504fca4283708 |
| scripts/plugin-template-privacy.test.ts | 不存在（新規） | 3d3a52f3a9875a486b42094134f7f47ed0840f68cda302b870e6ebce53c46c34 |
| packages/plugin-template/dist-mcp/index.js | 1a437bc07a447a28413378c6de0e8d738b710565c2d2cac630ccc23b937a2cc2 | a21cba6068f6807aae9421ef4749ce4111c8f9ab8df04d25d4cfe2d218f17ffa |

## tools/list契約差分の追加判断

F29-generated-tools-contract.json全文を読取り。旧/current両toolのname/description/properties/required/enum/taskSupportは同じで、object内field順以外の差はinputSchema.additionalProperties:falseの省略。deepEqual失敗は実在し、先のsmokeだけで完全同一契約を主張できない。
判定: 宣言上の入力許可範囲拡大であり、旧来有効だったinputを拒む破壊的変更ではない。ただし既存fieldを単に足した変更ではなく、未知property拒否という宣言制約の緩和。『意味不変』『無条件に安全なadditive』とは扱わない。現時点はconcern/条件付き受入判断で、差分単独から阻害findingと断定しない。
JSON SchemaのadditionalProperties省略では追加propertyを制限しないため、新clientは以前schema上不適格だったextra key付きinputを構築し得る。旧schemaへのrollbackやstrict schema consumerには影響があり得る。一方、既存callerの既知fieldだけのinputは旧/current双方で有効で、名前/required/enumも維持される。
親の実inputvalidation比較でrequired/enum拒否とextra keyの扱い（reject/strip/pass-through）を照合することが必要。extraが旧currentともstripされhandlerへ渡らず、既知inputの挙動が同じなら、runtime認可/副作用の弱化をこの差だけから認定しない。差異が追加inputを副作用へ到達させる、またはstrict consumerが新schemaを使えない具体的証拠があれば阻害扱いへ変更する。
F29のprivacy修復とは別の、再生成に伴う既存依存差として明記して採択する必要がある。承認済み契約保全を最優先に完全一致を要求する場合は、正本のschema生成設定/対応SDK入口でfalseを維持し正規再buildする方針が適切で、bundle直接編集は不可。本reviewはその実装案の成立まで確認していない。
実施はJSON読取りと本追補のみ。実inputvalidation・strict consumer・外部接続は未実施。既存deepEqual失敗と先の未確認/whitespace警告は消さず保持する。

# packages — 共有パッケージ

| パッケージ | 役割 | 薬局フォークでの位置づけ |
|---|---|---|
| `db` | D1 スキーマ(`schema.sql`)、追加型マイグレーション(`migrations/custom_0NN_*.sql`)、クエリヘルパー(`src/*.ts`)、`bootstrap.sql`(全マイグレーションの束) | **薬局のスキーマ変更はここ**。`custom_NNN` は追記のみ、既存ファイルは変更しない。`scripts/check-migrations.ts` が整合性を検証。テストは `test/custom_0NN_*.test.ts` を対で置く |
| `shared` | 型定義・定数 | Worker / Web / LIFF で共有 |
| `line-sdk` | LINE Messaging API 薄ラッパー | エラーメッセージに上流レスポンス本文を含めない(秘密情報対策) |
| `sdk` | 外部向け TypeScript SDK | フォーク元由来 |
| `mcp-server` | Claude Code 等から操作する MCP server。`src/custom/pharmacy/` に薬局向け操作 | 薬局向け追加はその配下 |
| `create-line-harness` | フォーク元の汎用セットアップ CLI | 薬局 tenant の作成は `scripts/custom/pharmacy` を使う |
| `update-engine` | 自己更新エンジン | フォーク元由来 |
| `plugin-template` | プラグイン雛形 | フォーク元由来 |

ルール: `line_account_id` / `tenant_id` で scope しないクエリを `db` に追加しない。PHI を含む列は暗号化方針(`docs/pharmacy/FIELD_LEVEL_ENCRYPTION_DESIGN.md`)に従う。

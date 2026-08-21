# 薬局リッチメニュー全体レビュー

## 判定

画面切替は実装済みです。D1の複数ページ、管理画面のページタブ、`richmenuswitch` の遷移先指定、公開時のLINE alias解決、プレビューまで一つの状態モデルに揃っています。

画像はページ単位でR2へ保存し、D1の `image_r2_key` と `image_content_type` から復元します。薬局初期画像は `custom` 配下のAssetから準備APIが冪等にR2へコピーします。Codex/Claude Codeからも `manage_pharmacy_rich_menus(action="save_image")` で同じ保存経路を使えます。`set_switch` で既存エリアをページ切替に変換することもできます。

## Lステップ系の設計から採用した考え方

| 考え方 | この実装 |
| --- | --- |
| 複数の画面を一つのメニュー体験として扱う | `rich_menu_groups` と複数 `rich_menu_pages` |
| タブ押下で別画面へ切り替える | `richmenuswitch` + ページ alias |
| まず下書きで確認する | D1 `draft`、管理画面プレビュー |
| 公開対象を明示する | LINE登録、友だち適用、全員デフォルトを分離 |
| 画像を画面定義と一緒に保持する | R2画像 + D1ページメタデータ |

## 公式リポジトリ更新への耐性

確認時点の参照は次のとおりです。

| 項目 | 値 |
| --- | --- |
| upstream | `Shudesu/line-harness-oss` |
| upstream/main | `eedfd7ed3a147f425eb69b86b76cb1ab863efe35` |
| pharmacy/dev HEAD | `2f01bee9422095437dcd1b7456cbc4eb963be2b5` |
| 更新入口 | `.github/workflows/update-from-upstream.yml` が `dev` 向けPRを作成 |
| 本番更新入口 | 中央`main`から単一Cloudflare環境へデプロイ。顧客別更新は行わない |

### 強い境界

- Worker、LIFF、Admin、MCPの薬局ロジックは `*/src/custom/pharmacy/` に配置。
- 初期画像は `apps/worker/public/custom/pharmacy/` に配置。
- 薬局DB拡張は `packages/db/migrations/custom_*.sql` と対応テストに分離。
- MCP登録は共通の登録点一箇所だけを変更し、実装本体は `packages/mcp-server/src/custom/` に配置。

### 手動レビューが必要な境界

- `apps/worker/src/index.ts` のroute登録。
- 共通のRich Menu API、DBモデル、bootstrap生成物。
- 共通Adminのリッチメニュー編集画面とAPI型。
- `packages/db/migrations/custom_*.sql` の適用順序・checksum。

結論として、独自コードの大半は更新で上書きされません。ただし共通の登録点・DB・管理画面はupstream変更と競合し得るため、`dev`向けupstream PR、全テスト、D1 migration確認、実機LINE確認を通過させてから`main`へ昇格させます。完全な自動マージ対象ではありません。

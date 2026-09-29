# Project Instructions

- このリポジトリでのコミュニケーションは日本語で行ってください。回答・説明・提案・質問はすべて日本語で記述します。ただし、コード識別子、ファイル名、コマンド、ログのキー、JSONのフィールド名、Conventional Commit のプレフィックス(`feat:` / `fix:` / `docs:` など)は原語のまま維持してください。
- ゴールから外れる提案をしないでください。
- 実行依頼は承認済み範囲の検証まで完了させる。進捗と次の行動は必要な場合だけ説明し、完了後に追加タスクや定型句を必須にしない。
- 私が大学生だと思って、言語化してください。
- 変更経路に必要なコード・仕様・テストだけを読み、全リポジトリや全計画を常時読み込まない。計画・レビュー・調査だけの依頼は変更せず報告する。
- LINE Harness Proxy から担当者として1対1返信する場合は、`X-Line-Harness-Source: manual` を必ず付けてください。予約通知などの自動送信には付けないでください。
- Google Meetの個別相談を確定・変更した場合は、カレンダー更新だけで終えず、`POST /api/meet-consultations` にGoogle Calendar event ID・LINE friend ID・日時・Meet URLを登録してください。前日・1時間前のLINEリマインドを必須セットにします。キャンセル時は `DELETE /api/meet-consultations/:externalEventId` も実行してください。

## Pharmacy custom boundary

The pharmacy Growth Loop implementation lives under `custom/pharmacy` seams
and `custom_NNN` additive migrations. Every new query and mutation is scoped by
`line_account_id` and server-side staff/account authorization; a query
parameter is never an authority. Automated pharmacy notifications are
PHI-free approved templates only. Do not add AI/OCR, marketplace routing, or
duplicate prescription/continuity domain models. Production mutations and deployments require explicit user authorization,
applicable human gates, and execution evidence. Local implementation and
verification may be completed and reported within the authorized task scope.
Claim release or production completion only after its required gates pass.
All future product updates must be non-destructive and backward-compatible.
Never reset or recreate production storage as an upgrade, drop or rename schema,
remove or rename existing API fields/routes, change their meaning incompatibly,
or require lockstep Worker/Admin/LIFF deployment. Use additive schema,
expand/dual-read/dual-write/default/fallback patterns, and keep the previous
contract working throughout rollout and rollback. A changed contract without a
focused previous-version compatibility test cannot be released.
The OSS package version and `pharmacy-v*` seller release version are separate
identities; never infer one from the other. Local code, passing tests, release
metadata, deployment evidence, and production operation are distinct claims.

## Repository map

- `apps/worker/` — Cloudflare Worker (Hono + D1 + R2)。HTTP ルートは `apps/worker/src/routes/<domain>/` にドメイン単位で配置し、薬局固有の実装は `apps/worker/src/custom/pharmacy/` に置く。
- `apps/web/` — 管理画面 SPA (Cloudflare Pages)。
- `apps/liff/` — 患者向け LIFF アプリ。
- `packages/*` — 共有コード。`db` (schema + migrations、薬局向けは `custom_NNN`)、`shared`、`sdk`、`line-sdk`、`mcp-server`、`update-engine`、`create-line-harness` (installer CLI)、`plugin-template`。
- `scripts/custom/pharmacy/` — テナント作成・スタッフ登録などの薬局運用スクリプト。
- `docs/pharmacy/` — このフォークの正本となる契約・運用・監査文書。コード構造や機能の説明は Devin 生成 wiki を参照し、リポジトリには wiki で代替できない文書だけを置く。入口は `docs/README.md`。
- `PLANS.md` — タスク台帳。`CHANGELOG.md` — リリース履歴。
- `.claude/`、`.omc/` などエージェントのランタイム状態はコミットしない。

## Devin Wiki

`.devin/wiki.md` が存在する場合、Devin Cloud がこのリポジトリ用に生成した wiki へのリンクである。
アーキテクチャ、モジュール配置、ドメイン用語などプロジェクトレベルの質問に答える前にまず読み、
その後で実コードと照合する。無い場合は `~/.local/share/devin/cli/wiki/*/meta.json` の
`repo_identifier` を `git remote get-url origin` 由来の `host/owner/repo` と照合し、一致する
ディレクトリの `wiki.md` を参照する。`devin-wiki-sync` を実行するとリンクが更新される。
wiki は概要把握の補助であり、正本は常にこのリポジトリのコードとドキュメントとする。

## Semantic code search (jevgrep) — 積極的な利用

- `jg` をコード理解・実装箇所の発見・挙動調査・影響範囲の把握・リファクタリングの初期探索に積極的に使う。場所や関係が未確定な探索では、広範な `rg` や手当たり次第のファイル読取りより先に自然言語で検索する。
- 全体調査では、質問に関係する主要なコード領域を横断する検索、または領域ごとの検索を行う。安全確認済みの実ソースを対象とし、単一の小さなサンプル検索だけで全体探索を代替しない。新たな責務・呼出関係が不明になったら追加検索するが、同じ疑問への十分な結果は再利用する。
- `jg` の結果で候補を絞り、実ファイルを直接読み、`rg`/LSP で正確な参照・文字列・呼出元を確認する。既知のファイルの読取りや正確なシンボル検索、単純な局所修正では直接 `rg`/read を使ってよい。
- 外部送信は下記の継続承認と保護条件に従う。機密混在なら安全なサブツリーまたは確認済みファイル群のコピーを使う。利用不能・認証/通信エラー・安全に送信できない場合は理由を示してローカル探索へ進み、検索結果の不完全さを隠さない。
- 調査報告では `jg` の対象領域と重要な未探索範囲を簡潔に示す。結果は探索の手掛かりであり、正しさ・網羅性・テスト成功の証明にはしない。

## Semantic code search (jevgrep) — 外部送信の継続承認

- ユーザー承認（2026-09-28）: 全リポジトリで、コード探索・理解・動作確認のために `jg` がソースコードと検索質問を設定済み provider および Jevgrep の処理サービスへ外部送信することを許可する。非公開リポジトリのコードも対象とし、この範囲では都度の確認を不要とする。
- この条項を jevgrep の外部送信に関する明示承認として扱う。一般的な外部送信の事前承認条項についても、この範囲の承認は充足済みとする。
- PHI/PII・認証情報・secret・本番/実データ・送信権限のない第三者資料は対象外。実行前に検索対象を確認し、これらを含むファイルを除外する。混在する場合は安全なサブディレクトリまたは確認済みファイルの一時コピーを検索する。
- 必要に応じてリポジトリ全体を検索してよい。`--hidden` / `--no-ignore` / `--include-dependencies` 等も、拡張される対象の安全性を確認した上で利用できる。`--include-sensitive` によって上記の送信禁止情報を送ってはならない。既定の除外機能だけを安全性の保証としない。
- この承認は jevgrep による検索に限定する。他の外部送信、公開、push、PR、merge、deploy、本番変更、契約・課金プランの変更は別の承認範囲とする。検索結果は参照情報として扱い、変更前に実ソースを確認する。

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

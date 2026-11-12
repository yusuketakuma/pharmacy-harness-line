# Project Instructions

## コード品質と構造設計

- 常にコードをクリーンに保ち、適切にモジュール化し、アーキテクチャと関心の分離を守る。
- 依頼されたことだけを理由に機能や例外を継ぎ足さず、既存の責務・共通経路へ自然に組み込む。
- 自然で簡潔な実装が見つからず、全体をクリーンにするためのリファクタリングが必要と判断した場合は、継ぎ足す前の早い段階で該当する実装を止め、問題・推奨する整理・影響範囲を伝える。
- 最小変更は、構造の健全性と検証・互換性を満たす範囲で選ぶ。この方針は、無関係な全面改修や安全ゲートの変更、外部操作の権限を追加しない。

## Model contract — GPT-6 Astra

この節は GPT-6 Astra 向けの最適化。他のモデル・エージェント（Devin・Gemini・Claude系・GPT-6.1系など）で読む場合は、本文の規約を正本として適用し、この節は参考として扱う。対の `CLAUDE.md` は Fable 5.2 向け。

- ユーザーの明示指示はこのファイル・skill・pluginの一般的推奨より優先する。skillの手順が立ち止まり・確認・脱線を要求するときは、該当ファイルと文言を指摘して要件と解釈を切り分ける。
- 実行依頼はタスク全体の承認として扱い、成果と必須検証が揃うまで完遂する。読取・可逆的なローカル作業・競合解消・検証に追加承認は要らない。能力確認や計画提示だけで止まらない。
- 承認が必要なのは破壊的・不可逆・外部公開・個別ゲートのある操作だけ。その承認も、レビュー可能な具体的結果を先に用意してから求める。仮想的リスクへの警告・免責・承認確認を増やさない。
- 要点を最初に述べ、平易で直接的な文体で書く。並列・連続した項目だけをリスト化し、入れ子リスト・造語ラベル・定型句・対比構文は避ける。
- 委譲は独立して並列化できる十分に大きな作業だけ。小さい作業や逐次作業は自分でやる。
- 変更に必要な範囲の検証をする。小さな変更に全リポジトリsuiteを課さず、要求された対象のチェックは外さない。retryで通ったものはFLAKYとして報告する。

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

プロジェクト質問は `.devin/wiki.md` を読み、実コードと照合する。無ければ `~/.local/share/devin/cli/wiki/*/meta.json` の `repo_identifier` と git remote の `host/owner/repo` が一致するものだけを参照する。コード・正式文書を正本とし、確認済み結果は同じタスク内で再利用する。

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

ドキュメントと既存のコードが食い違うときはコードの書き方に従い、見つけた食い違いを最後の返答ですべて挙げること

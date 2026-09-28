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

<!-- BEGIN DEVFLOW MANAGED -->
## Devflow 共通運用（managed block — この block 内のみ devflow が更新する）

- 中央管理: `~/.config/devflow/`（registry/policy/roles/bin）,
  task 正本: `~/.local/state/devflow/tasks/line/<task_id>/`,
  worktree: `~/.herdr/worktrees/devflow/line/<task_id>/`
- agmsg team `devflow-line` seats: planner(codex) / builder(devin) / reviewer(codex)。
  delivery: codex seats=turn（`.codex/hooks.json` Stop+PostToolUse hook）、
  builder=off（手動受信 `bash ~/.agents/skills/agmsg/scripts/inbox.sh devflow-line builder`）。
  agmsg は通知用のみ — task 状態の正本は PLAN/STATUS/git/VERIFY/REVIEW。
- 役割定義: `~/.config/devflow/roles/`（planner=計画のみ / builder=worktree内実装 /
  reviewer=独立レビュー・修正禁止）
- 実行権限: Astra planner/reviewer = Auto 相当（codex `-s workspace-write
  -a on-request` + `approvals_reviewer="user"` + `sandbox_workspace_write.network_access=false`。
  workspace-write は業務コードへの書込みを技術的に禁止しない — 計画/レビュー専任は
  role 規約と diff 検査で守る）。Devin builder = Bypass（`--permission-mode dangerous`、
  OS sandbox 無し — 境界は role 規約と devflow 権限 deny ルール）。
- task packet: PLAN.md ACCEPTANCE.md STATUS.json HANDOFF.md VERIFY.md REVIEW.md。
  PLAN/ACCEPTANCE は `devflow ready` で hash 固定。変更は Planner へ差し戻し新版で。
- 外部操作禁止: push/PR/merge/deploy/外部送信/本番・実データ変更は明示承認のみ。
  commit は Builder が PLAN の Commit Group 設計に沿った検証済み論理グループ単位で
  worktree 内の作業 branch にのみ行う。秘密情報・患者情報を agmsg/文書に含めない。
- 受入: ACCEPTED は技術的受入のみ。merge/deploy の許可ではない。
<!-- END DEVFLOW MANAGED -->

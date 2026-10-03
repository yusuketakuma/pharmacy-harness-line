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

プロジェクト質問は `.devin/wiki.md` を読み、実コードと照合する。無ければ `~/.local/share/devin/cli/wiki/*/meta.json` の `repo_identifier` と git remote の `host/owner/repo` が一致するものだけを参照する。コード・正式文書を正本とし、確認済み結果は同じタスク内で再利用する。

## Semantic code search (jevgrep)

- 場所・関係・影響が未確定の探索は `jg`。既知ファイル・正確なシンボル・局所修正は read/rg/LSP。全体調査は主要領域を横断、または領域ごとに検索し、実ソースで確認する。
- ユーザー継続承認（2026-09-28）により、全リポジトリの非公開コードと質問をコード探索・理解・動作確認のため `jg` の設定済み provider / Jevgrep 処理サービスへ送れる。この範囲の一般的な事前承認も充足済み。他の外部送信・公開・push/PR/merge/deploy・契約/課金変更は含まない。
- PHI/PII・認証情報・secret・本番/実データ・送信権限のない第三者資料は送らない。実行前に対象を確認・除外し、混在時は安全なサブツリーか確認済みコピーを使う。拡張検索フラグも同じ条件で、既定除外を安全の証明にせず `--include-sensitive` でも禁止情報を送らない。
- 利用不能・認証/通信エラー・安全な対象を作れない場合は理由を示してローカル探索を続ける。対象領域・重要な未探索範囲・不完全さを報告し、検索結果を正しさ・網羅性・テスト成功の証明にしない。

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

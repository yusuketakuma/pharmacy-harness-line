# Project Instructions

- このリポジトリでは日本語で回答・説明・提案・質問を書く。コード識別子・ファイル名・コマンド・ログのキー・JSONのフィールド名・Conventional Commitのプレフィックスは原語を維持する。
- ゴールから外れる提案をしないでください。
- 進捗と次の行動は必要な場合だけ説明し、完了後に追加タスクや定型句を必須にしない。
- 全リポジトリや全計画を常時読み込まない。
- 私が大学生だと思って、言語化してください。
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

- `apps/worker/src/routes/<domain>/` にHTTPルート、`apps/worker/src/custom/pharmacy/` に薬局固有の実装を置く。
- `apps/web/` は管理画面、`apps/liff/` は患者向けLIFF、`packages/*` は共有コード。薬局向けmigrationは `packages/db/` の `custom_NNN` を使う。
- `scripts/custom/pharmacy/` は薬局運用スクリプト、`docs/pharmacy/` は契約・運用・監査文書の正本。文書の入口は `docs/README.md`。コード構造や機能の説明は生成wikiを参照し、リポジトリにはwikiで代替できない文書だけを置く。
- `PLANS.md` はタスク台帳、`CHANGELOG.md` はリリース履歴。
- `.claude/`、`.omc/` などエージェントのランタイム状態はコミットしない。

## Devin Wiki

- Wikiは依頼されたとき、未知の構造・依存関係が作業に影響するとき、コード確認後も重要な不明点が残るときに参照する。
- Devin Wikiは `.devin/wiki.md` を使う。無ければ `~/.local/share/devin/cli/wiki/*/meta.json` の `repo_identifier` とgit remoteの `host/owner/repo` が一致するものだけを参照する。

以下のOpenWiki管理ブロックはツールが更新する。自動更新の記述は稼働の証拠ではない。`.github/workflows/openwiki-update.yml` の有無と実行結果で判断する。

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

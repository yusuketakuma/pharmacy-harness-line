# Project Instructions

- このリポジトリでのコミュニケーションは日本語で行ってください。回答・説明・提案・質問はすべて日本語で記述します。ただし、コード識別子、ファイル名、コマンド、ログのキー、JSONのフィールド名、Conventional Commit のプレフィックス(`feat:` / `fix:` / `docs:` など)は原語のまま維持してください。
- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。
- LINE Harness Proxy から担当者として1対1返信する場合は、`X-Line-Harness-Source: manual` を必ず付けてください。予約通知などの自動送信には付けないでください。
- Google Meetの個別相談を確定・変更した場合は、カレンダー更新だけで終えず、`POST /api/meet-consultations` にGoogle Calendar event ID・LINE friend ID・日時・Meet URLを登録してください。前日・1時間前のLINEリマインドを必須セットにします。キャンセル時は `DELETE /api/meet-consultations/:externalEventId` も実行してください。

## Pharmacy custom boundary

The pharmacy Growth Loop implementation lives under `custom/pharmacy` seams
and `custom_NNN` additive migrations. Every new query and mutation is scoped by
`line_account_id` and server-side staff/account authorization; a query
parameter is never an authority. Automated pharmacy notifications are
PHI-free approved templates only. Do not add AI/OCR, marketplace routing, or
duplicate prescription/continuity domain models. Production mutation,
deployment, and completion claims require explicit evidence and a human gate.
The OSS package version and `pharmacy-v*` seller release version are separate
identities; never infer one from the other. Local code, passing tests, release
metadata, deployment evidence, and production operation are distinct claims.

---
type: concept
title: プライバシー・暗号化・保持と削除
description: 問診の項目暗号化(AES-256-GCM の envelope)、PHI を出さない構造化ログ、3 年一律の保持と legal hold、データ主体請求(DSR)、承認と fence を必須とする recovery 経由の削除、開発済みと本番未実施の区別を説明する。
tags: [privacy, phi, encryption, retention, legal-hold, dsr, recovery]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-69bde9a2d851337e7c72277c
    resource: repo://apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts
  - id: openwiki-source-fbac17cdd111221b4451a90b
    resource: repo://apps/worker/src/custom/pharmacy/data-subject-requests/routes.ts
  - id: openwiki-source-37aca1e8c89e599a925deeaa
    resource: repo://apps/worker/src/custom/pharmacy/intake/encryption.ts
  - id: openwiki-source-c09a971d0fdfafcd0ef4e5da
    resource: repo://apps/worker/src/custom/pharmacy/logging-privacy.test.ts
  - id: openwiki-source-42c9c8adc50b250a80e7a601
    resource: repo://apps/worker/src/custom/pharmacy/recovery/operations.ts
  - id: openwiki-source-ce0633b07280138ef3a576bf
    resource: repo://apps/worker/src/custom/pharmacy/retention/execution.ts
  - id: openwiki-source-2565a7584bebc0ede344e1de
    resource: repo://apps/worker/src/custom/pharmacy/retention/fence.ts
  - id: openwiki-source-8459ecdb239b076f40246d0d
    resource: repo://apps/worker/src/lib/log.ts
  - id: openwiki-source-d2b18a23c9710d5a65a56c0c
    resource: repo://docs/pharmacy/FIELD_LEVEL_ENCRYPTION_DESIGN.md
  - id: openwiki-source-dc968ceee7a1aa7aa1c92584
    resource: repo://docs/pharmacy/RETENTION_MATRIX.md
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# プライバシー・暗号化・保持と削除

薬局の患者データ(PHI)は、暗号化して保存し、ログに出さず、保持期限と法定保存の判定に従って消し、その削除自体を承認と実行の証跡で守ります。このページはその仕組みと、「コードとして実装済み」と「本番で実施済み」の区別を説明します。正本文書は `docs/pharmacy/FIELD_LEVEL_ENCRYPTION_DESIGN.md` と `docs/pharmacy/RETENTION_MATRIX.md` です。両文書とも、本番への secret 投入・backfill・scrub・削除・R2 lifecycle 確認・deploy は `NOT_RUN`(未実施)で、production readiness を主張しないと明記しています。

## 項目暗号化(問診)

最初の暗号化対象は `pharmacy_patient_intake_responses` の `answers_json`(アレルギー・妊娠・既往歴・自由記述を含み得る)と、同じ回で暗号化する `patient_snapshot_json` です(`PATIENT_INTAKE_ENCRYPTED_FIELDS`)。

- **方式**: Web Crypto の AES-256-GCM。記録ごとに 96 ビットのランダム nonce を使い、同じ鍵で再利用しません。
- **AAD**: `tenant_id`・`line_account_id`・`owner_friend_id`・`patient_id`・回答 `id`・`schema_version`・項目名・envelope 版を束ねます。別テナントや別項目へ暗号文を差し替えると復号に失敗します。
- **鍵**: `PHARMACY_PHI_KEY_V1` と別途生成する `PHARMACY_PHI_KEY_V2`。LINE 資格情報の鍵とは共用しません。新規書込みに使う版は `PHARMACY_PHI_ACTIVE_KEY_VERSION` で明示した場合だけ 2 になり、V2 の secret を置いただけでは 1 のままです。不正な secret や未知の版は問診の読書きを fail-closed にします。
- **検索性**: 決定的なルックアップ用ダイジェストを作らず、回答内容では検索できません。
- **保存**: 既存 migration を変えず、`(response_id, line_account_id, owner_friend_id, patient_id)` で結ぶ追加テーブルに envelope を持たせます。

読取りは dual-read です。暗号化行を優先し、暗号化行が無いときだけ旧平文を読みます。壊れた envelope は平文へ落とさず失敗にします。書込みは暗号化行の insert が回答の insert と同じ D1 batch で成功することを必須にします。暗号化は認可の代わりにはならず、復号は `line_account_id`・所有者・患者の関係を検査した後だけです。鍵や復号の失敗は汎用の 5xx と PHI を含まないエラーコードだけを返します。

緊急避妊(EC)の payload も `PHARMACY_PHI_KEY_V1` を使うため、問診側の v1 参照が 0 になっても旧 secret の廃止の根拠にはなりません(EC 側の別 rotation が終わるまで `BLOCKED`)。`crypto-utils.ts` は base64url の厳格な符号化・復号や定時間比較などの共通部品です。

### 平文の scrub と復元

移行は段階的です。dual-read を配備し、有界・再開可能な backfill(暗号化→復号→バイト比較で検証)を行い、暗号化優先の書込みへ切り替えます。カバレッジが 100%、検証済みバックアップ、鍵の復旧確認、書込み凍結、別 principal の承認と実行が揃った場合だけ、旧平文列を有効な空 JSON の sentinel に CAS 更新します(列は drop しません)。scrub 後にロールバックするには、暗号文を旧列へ復号し戻す明示的な restore が必要で、黙ったフォールバックは禁止です。

## ログの privacy

`lib/log.ts` の `log` は 1 イベント 1 行の JSON で、許可リスト(`tenant_id`・`line_account_id`・`route`・`method`・`status`・`reason`・`count` など)にあるキーだけを出力します。Error 値は `名前: メッセージ` を 200 文字に切ります。PHI・資格情報・リクエスト本文は許可リストに無いので、誤って出ません。`logging-privacy.test.ts` は Worker のソース全体を走査し、`console.*` に LINE ユーザー ID・患者 ID・トークン・回答などを渡す書き方があれば失敗させます。

## 保持期間と法定保存(legal hold)

経営判断(2026-08-19)で、PHI を持つ全ストアに `retention_years = 3` を一律に適用します。根拠は薬剤師法施行規則の調剤録・調剤済み処方箋の保存期間で、問診回答・マイナ連携・LINE メッセージへの拡張は法定義務ではなく管理上の判断です。個人情報保護法 22 条は保存期間の数値を定めず、利用目的の達成後に遅滞なく消去する努力義務なので、この一覧が文書化された境界としてそれを果たす位置づけです。

`data-subject-requests/legal-hold.ts` は患者の最新 PHI 記録から 3 年間を `held`(法定保存中)とし、消去・利用停止の請求(`erasure`・`suspension`)には応じません。判定は `held`・`released`・`unknown` の 3 値で、時刻が null・非 UTC・不正、クエリ失敗、未知のソースは `unknown` として保存扱いに倒します(33 の時刻ソースを 1 つの inventory で評価)。

## データ主体請求(DSR)

`data-subject-requests/routes.ts` は薬局のアカウント境界(`pharmacyAccountGuard` 配下)で、請求の一覧・作成・本人確認・legal hold 判定・解決を提供します。判定と解決は owner/admin のみで、`expectedVersion` による楽観ロックを要求します。解決(`resolved`/`rejected`)には結果メモが必須です。DSR の request/event 自体は PHI の時計から除外し、tombstone 方針の課題として別管理です。

## 削除は recovery 経由のみ

通常の cron は 3 年経過の削除を直接実行しません。削除は platform admin の recovery operation(`fle_backfill`・`plaintext_scrub`・`plaintext_restore`・`retention_delete`・`restore_rehearsal`)としてのみ実行でき、次を満たす必要があります。

- 承認者と実行者が別の principal(リクエスト body の `approvedBy` は拒否し、認証済み principal だけを記録)。
- 有効期限、テナント・アカウント・現在の Worker 束縛への限定、有効な execution fence。
- preflight で検証済みバックアップ世代、スキーマ、33 のソース、行数・オブジェクト数、legal hold・DSR・incoming・R2 の inventory のダイジェストを固定し、ドリフトしたら変更前に停止。
- 処方箋 R2 の削除は、operation 単位の deletion intent(行の revision、保存済み SHA-256、hold epoch)を固定し、削除の直前に execution・hold・行・オブジェクトを再確認します。結果が不明なら `OUTCOME_UNKNOWN` で停止し、盲目的に再試行しません。
- incoming 画像は `messages_log`・追跡オブジェクト・R2 の inventory を照合して `ORPHAN`/`MISSING`/`OWNERSHIP_MISMATCH`/`UNKNOWN` を記録します。

<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
operation は `failed=0`・未解決の disposition が 0・readiness が `READY` のときだけ完了できます。文書時点では EC の売上・カウンター・監査と DSR tombstone の方針が未決で `BLOCKED` のため、処方箋・incoming 画像の保持削除は開始しません。一方、既存の workflow cleanup や、EC の `retention_days`(アカウントごとの期間)による payload の redaction は別の契約で、6 時間 cron から動きます(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-patient-journeys.md] link "/openwiki/workflows/pharmacy-patient-journeys.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
関連: [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md)、[薬局の患者導線](/openwiki/workflows/pharmacy-patient-journeys.md)、[薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md)。

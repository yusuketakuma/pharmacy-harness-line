# PHI retention matrix (H-5)

This document supersedes the provisional retention classes in
`SECURITY_REVIEW_EVIDENCE_2026-08-19.md` §E-6, which were explicitly marked as
pending this decision.

It describes local source and schema evidence plus one business decision. It
does not claim deployment, production configuration or production operation.

## The decision

| Field | Value |
| --- | --- |
| Decided | 2026-08-19 |
| `retention_years` | **3**, uniformly, for every PHI-bearing store |
| `basis` | `薬剤師法施行規則(調剤録・調剤済み処方箋の保存期間)を全PHIへ一律適用(経営判断、2026-08-19)` |
| Scope | 処方箋画像、調剤関連データ、問診回答、マイナ連携データ、LINEメッセージ本文を含む全PHI |

The 3-year figure is the statutory retention duty for 調剤録 and 調剤済み処方箋
under 薬剤師法施行規則. Extending it to data with no statute of its own
(問診回答、マイナ連携、LINE メッセージ) is a management decision, not a legal
requirement — one number is auditable and operable, several are not.

APPI 22条 does **not** set a numeric retention period; it is an 努力義務 to erase
personal data without delay once the purpose of use is achieved. The earlier
claim that indefinite image retention is "an APPI 22条 violation" was withdrawn.
This matrix is what discharges that 努力義務: a written, enforced boundary.

## R2 lifecycle rules: `NOT_RUN`

Consistent with §E-6, checked again on 2026-08-20:

- `apps/worker/wrangler.toml` declares the bucket bindings only
  (`line-harness-images-dev` at `:29`, `line-harness-images` at `:60`). Wrangler
  config cannot express R2 lifecycle rules, so their absence here proves nothing.
- There is no other IaC in the repository (`grep -rn lifecycle` over `*.tf`,
  `*.toml`, `*.ya?ml`, `*.json` returns nothing).
- The checked-in Cloudflare account identifier is the placeholder
  `YOUR_DEV_ACCOUNT_ID`, so no read-only API query can be issued from here.

**Whether an out-of-band lifecycle rule already deletes objects under any prefix
below is `NOT_RUN`, not "none".** Anyone with real account access must record the
answer before relying on the "Automatic deletion" column. A lifecycle rule that
already deletes objects would silently invalidate the tracked DB rows that point
at them.

## R2 prefixes

Retention is 3 years everywhere; the difference between rows is whether anything
in this repository can *find* the object to delete it.

| Prefix | Contents | PHI | Age reference | Enforcement |
| --- | --- | --- | --- | --- |
| `custom/pharmacy/prescriptions/tenants/{tenantId}/{submissionId}/{revision}/{fileId}` | 処方箋画像 | yes — highest density (patient name, drugs, prescriber, clinic) | `pharmacy_prescription_files.created_at` | **enforced** — `purgePrescriptionFilesPastRetention` (6h cron) |
| `tenants/{tenantId}/accounts/{accountId}/incoming/{messageId}.{ext}` | 着信 LINE チャット画像 | yes — patient may send anything | none in a column | **not enforced** — see "Deferred" |
| `tenants/{tenantId}/uploads/{uuid}.{ext}` | 管理者アップロード画像 (broadcast/template assets) | not by design; no patient path writes here | none | **not enforced** — no DB row at all |
| `rich-menus/{accountId}/{groupId}/{pageId}/{...}` | リッチメニュー画像 | no — regenerable configuration asset | `rich_menu_pages` row | out of PHI scope; replaced/deleted images already orphan |
| `webinars/{prefix}/...` | HLS 動画 | no — marketing, not a pharmacy surface | n/a | written out-of-band, never reaped |

The prescription prefix is the only one with a `r2_key` column
(`pharmacy_prescription_files.r2_key`, `UNIQUE`, `CHECK (r2_key LIKE
'custom/pharmacy/prescriptions/%')`). Every other prefix is either untracked or
tracked only as its *current* value, which is why enforcement stops there.

## DB tables

`retention_years` = 3 and `basis` as above for every row. "Age reference" is the
column the boundary is measured against; "Format" matters because a `+09:00`
string and a `Z` string do not compare correctly against the same cutoff.

### Enforced

| Table | PHI | Age reference | Format | Enforcement |
| --- | --- | --- | --- | --- |
| `pharmacy_prescription_files` | R2 pointer to the 処方箋画像 | `created_at` NOT NULL | ISO `Z` | R2 object deleted, row set `state='deleted'`, logged in `pharmacy_phi_retention_purge_log` |
| `pharmacy_webhook_event_receipts` | raw LINE webhook body — message text, `userId`, image ids | `received_at` NOT NULL | **JST `+09:00`** | already purged at **30 days** for settled rows (M-7, `purgeWebhookEventReceipts`); `pending`/`processing` rows are never purged and can therefore outlive 3 years |

### Not yet enforced — 3-year boundary defined, no purge job

Prescription aggregate (root `pharmacy_prescription_submissions.created_at`):

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `pharmacy_prescription_submissions` | pickup intent, consent timestamps, resubmission reason | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_prescription_events` | status/mutation audit | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_prescription_view_events` | staff image-read audit (`staff_id`) | **`viewed_at`** NOT NULL | ISO `Z` |
| `pharmacy_prescription_patients` | submission ↔ patient ↔ intake revision link | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_prescription_validities` | `issued_on`, `valid_until`, `validity_basis` | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_submission_sources` | referring clinic | **`entered_at`** NOT NULL | ISO `Z` |
| `pharmacy_submission_attributes` | none (`is_synthetic` only) | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_fulfillment_quotes` | dispensing decision JSON | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_print_tasks` | points at a printable revision | `created_at` NOT NULL | ISO `Z` |

Patient / intake:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `pharmacy_patients` | cleartext 氏名・カナ・生年月日・性別・電話・住所 | `created_at` NOT NULL (`archived_at` is a soft delete) | ISO `Z` |
| `pharmacy_patient_intake_responses` | 問診回答 `answers_json` + `patient_snapshot_json` | `created_at` NOT NULL | ISO `Z` |

Myna 連携:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `pharmacy_myna_handoffs` | patient-linked handoff state | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_myna_verifications` | staff free-text `note`, clinical outcome status | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_myna_events` | `metadata_json` | **`occurred_at`** NOT NULL | ISO `Z` |
| `pharmacy_prescription_expectations` | receipt state per patient | `created_at` NOT NULL | ISO `Z` |

Continuity / follow-up:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `pharmacy_continuity_obligations` | follow-up schedule, `consent_at` | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_continuity_events` | transition audit | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_next_intake_expectations` | `supply_days` — infers medication duration | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_next_intake_expectation_events` | transition audit | **`occurred_at`** NOT NULL | ISO `Z` |
| `pharmacy_medication_followups` | status leaks clinical signal (`concern`, `escalated`) | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_medication_followup_events` | transition audit | **`occurred_at`** NOT NULL | ISO `Z` |

Emergency contraception (`custom_035`) — the most sensitive category:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `pharmacy_emergency_intakes` | `encrypted_payload` (AES-GCM), plus cleartext `age_band`, `risk_flags_json` | `created_at` NOT NULL | ISO `Z` |
| `pharmacy_emergency_intake_events` | transition audit | **`occurred_at`** NOT NULL | ISO `Z` |

Core LINE tables:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
| `friends` | `line_user_id`, `display_name`, `picture_url`, `metadata` | `created_at` NOT NULL | **JST `+09:00`** |
| `chats` | `notes` — free-text staff notes about a patient | `created_at` NOT NULL | **JST `+09:00`** |
| `messages_log` | LINE message bodies, and the only surviving reference to incoming image R2 keys (inside a JSON `content` blob) | `created_at` | **JST `+09:00`** |

Audit-only, no patient content — a 3-year boundary applies by the uniform
decision, but deleting them destroys the evidence used to investigate misuse of
the data they describe. Sequence them **after** the data, never before:

| Table | Age reference |
| --- | --- |
| `pharmacy_activity_notifications` (PHI-free by construction, `dedupe_hash` only) | `created_at` |
| `pharmacy_emergency_admin_events` (inventory audit, no patient link) | `occurred_at` |
| `platform_admin_access_events` (cross-tenant admin audit; `detail_json` is unbounded and is the one place PHI could leak in) | `created_at` |
| `pharmacy_phi_retention_purge_log` (this mechanism's own log; contains no PHI and must outlive what it describes) | `purged_at` — **exempt** |

## What is enforced today

`apps/worker/src/custom/pharmacy/prescriptions/retention-purge.ts`, registered on
the existing 6-hour cron tick in `apps/worker/src/index.ts` next to
`cleanupPrescriptionImages`.

Fail-closed rules, mirroring `purgeWebhookEventReceipts` (M-7):

1. A file is purged only when `created_at` matches the UTC-`Z` shape the runtime
   actually writes **and** is strictly older than the boundary. Empty, date-only,
   JST-offset, and malformed values are kept, not guessed at. A missed purge is
   recoverable; a wrong delete is not.
2. The R2 object is deleted first, then the row is marked `state='deleted'`, then
   the purge is logged. The log row is the completion marker, so an interrupted
   run retries safely (R2 delete is idempotent) and never double-logs.
3. An R2 failure leaves the row unmarked and unlogged, so the next tick retries.
4. Each tick is bounded (50 files by default) so a large backlog cannot stall the
   cron.

This is a superset backstop over `cleanupPrescriptionImages`, which only reaps
images whose *workflow* ended and by design never touches the active revision of
a live submission. Past three years the image goes regardless of status,
including rows the workflow cleanup marked `deleted` but failed to remove from R2.

`pharmacy_phi_retention_purge_log`
(`packages/db/migrations/custom_037_pharmacy_phi_retention_purge_log.sql`) records
`resource_id`, `r2_key`, the `age_reference_at` the boundary was measured
against, `retention_years`, and `purged_at`. It holds no PHI and carries no
foreign key to the purged row — a foreign key would either block the delete or
cascade the evidence away with it.

## Deferred to a follow-up task

Ordered by risk. None of these are enforced today.

1. **Prescription aggregate row deletion.** The image is gone at 3 years but the
   surrounding rows remain. Deleting a submission requires an ordered delete
   across ~11 tables, most of whose foreign keys do **not** declare
   `ON DELETE CASCADE` (`pharmacy_prescription_patients`,
   `pharmacy_fulfillment_quotes`, `pharmacy_print_tasks`, and the myna/continuity/
   follow-up chains). A partial delete either fails on a foreign key or orphans
   PHI. `pharmacy_continuity_obligations.candidate_submission_id` is the one
   genuinely ambiguous edge: it can point at a *newer* submission than its own
   source.
2. **`pharmacy_patients` and `pharmacy_patient_intake_responses`.** The strongest
   identity PHI in the schema. Blocked on (1): `pharmacy_prescription_patients`
   holds a foreign key to both, and `base_response_id` forms a self-referencing
   revision chain that must be deleted leaf-first.
3. **Incoming LINE chat images** (`tenants/{t}/accounts/{a}/incoming/`). No column
   stores the key — it survives only as a URL inside `messages_log.content` JSON.
   Enforcement needs either a tracking column (additive migration) or a bounded
   `R2.list()` sweep reconciled against `messages_log`. Do not blind-delete by
   prefix age; there is no age reference on the object that this repository owns.
4. **`messages_log` / `chats` / `friends`.** JST-formatted timestamps, so they
   need their own cutoff string — the UTC cutoff used above is wrong for them by
   9 hours, and mixing the two is exactly the kind of silent off-by-one that
   deletes live data. Also the largest row counts, so a bounded batching strategy
   matters more than for prescriptions.
5. **Emergency contraception (`custom_035`).** Already has its own
   `pharmacy_emergency_settings.retention_days` (1–365) knob, which is *shorter*
   than 3 years and product-specific. Confirm with the operator whether the
   uniform 3-year rule raises that floor or whether the shorter, deliberately
   chosen window wins before touching it.
6. **`pharmacy_webhook_event_receipts` stragglers.** Settled rows are purged at 30
   days, but `pending`/`processing` rows are deliberately never purged and carry
   raw LINE message bodies. A row stuck pending for 3 years is a PHI retention
   hole *and* a stuck-queue bug; fix the bug, do not add a delete.
7. **Audit tables.** Sequencing question, not a mechanism question — they must
   outlive the data they describe. Decide the offset before implementing.

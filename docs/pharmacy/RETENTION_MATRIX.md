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
| `tenants/{tenantId}/accounts/{accountId}/incoming/{messageId}.{ext}` | 着信 LINE チャット画像 | yes — patient may send anything | `pharmacy_incoming_image_objects.stored_at` (`custom_050`, forward-only from commit e028b86) | **not enforced** — the R2 key is now tracked, but no purge job consumes it and there is no backfill for objects written before `custom_050`; see "Deferred" |
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
| `pharmacy_webhook_event_receipts` | raw LINE webhook body — message text, `userId`, image ids | `received_at` NOT NULL | **JST `+09:00`** | purged at **30 days** for both settled and dead-lettered rows (M-7 + NEXT-6, `purgeWebhookEventReceipts`); `sweepWebhookInbox` dead-letters any `pending`/`processing` row past 24h with no live lease, so nothing can silently outlive 3 years anymore |
| `pharmacy_emergency_intakes` | `encrypted_payload` (AES-GCM), plus cleartext `age_band`, `risk_flags_json` | `created_at` NOT NULL | ISO `Z` | **partially enforced** — account's own `pharmacy_emergency_settings.retention_days` (1–365) takes precedence over the uniform 3-year rule for the self-declaration payload only (NEXT-2); see "Emergency contraception retention" below for the residual identifying columns this does **not** clear |

Plaintext column set for `pharmacy_emergency_intakes` is unchanged by the ECF-4
Phase A payload v2 rollout, except that `risk_flags_json` may now also contain
`pre_review_flagged` (one summary flag, no breakdown) alongside the existing
`time_unknown`/`under_16`/`minor_review`/`repeat_purchase_review`/`notification_unavailable`
values. `encrypted_payload` (`schema_version: 2`) additionally carries
`lngAllergy`, `liverDisease`, `currentlyPregnant`, `breastfeeding`,
`detailFlags`, `checklistVersion`, `consentContentHash` — all inside the
existing AES-GCM envelope, no new plaintext columns. `listOwnerEmergencyIntakes`
(patient-facing projection) does not carry `risk_flags` or `age_band`.

ECF-6 (Phase B) adds the following fields to the same `schema_version: 2`
encrypted payload, still inside the existing AES-GCM envelope with no new
plaintext columns: `underMedicalTreatment`, `drugAllergyHistory`,
`heartKidneyGiDisease`, `stJohnsWort` (B1-B4), `lastMenstruationDate`,
`menstruationSignals` (C1/C2), `idDocumentAvailable` (D3), and the
server-computed `pregnancy_test_recommended` (pharmacist-only; never shown to
the patient, never mirrored into `risk_flags_json`).

### Phase B additions (ECF-5): counter confirmations and sale records

| Table | PHI | Age reference | Format | Enforcement |
| --- | --- | --- | --- | --- |
| `pharmacy_emergency_counter_confirmations` | none — `mismatch_items_json` holds only item codes (e.g. `lngAllergy`), never the patient's actual answers, which stay sealed in `pharmacy_emergency_intakes.encrypted_payload` | `confirmed_at` NOT NULL | ISO `Z` | **not enforced** — 3-year class, same as the intake it confirms; no purge job today |
| `pharmacy_emergency_sale_records` | plaintext `outcome`/`sold_at`/`product_code`/`identity_check`/`in_person_dose`/`checklist_sheets_received`/`pharmacist_staff_id`/`training_registration_number`; `determination_encrypted` (AES-GCM: pregnancy test result, refusal reason code, referral, explained items) | `sold_at` NOT NULL | ISO `Z` | **not enforced** — 3-year class (statutory minimum per 医薬総発 0331 第2号 4(3)), **not** the account's `retention_days`; see below |

`pharmacy_emergency_sale_records` carries its own `owner_friend_id` column
(not resolved via a join to the intake) specifically so the legal-hold query
against `pharmacy_data_subject_requests(line_account_id, owner_friend_id)`
stays a plain equality lookup even after the parent intake row has been
redacted by NEXT-2. It is **not** touched by the `retention_days` redaction
described above — that redaction only clears `pharmacy_emergency_intakes.encrypted_payload`
/ `risk_flags_json`, never the statutory sale record, which is a distinct
table with its own 3-year class and an unconditional `BEFORE UPDATE` /
`BEFORE DELETE` trigger (`pharmacy_emergency_sale_records_no_update` /
`pharmacy_emergency_sale_records_no_delete`) making it immutable. Because of
that `no_delete` trigger, a future 3-year boundary purge cannot delete this
row outright — like `pharmacy_emergency_intake_events` (row 26 below), it must
**redact `determination_encrypted`** (set to `''`) rather than delete, leaving
the plaintext statutory columns (`outcome`, `sold_at`, `product_code`,
`identity_check`, etc.) in place as the durable record required by law.

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

Emergency contraception (`custom_035`) — the most sensitive category, and the
only PHI store with its own **shorter** boundary; see "Enforced" above for the
`pharmacy_emergency_intakes` row, now moved out of this deferred section:

| Table | PHI | Age reference | Format |
| --- | --- | --- | --- |
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

### Emergency contraception retention (NEXT-2)

`apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts`,
registered on the same 6-hour cron tick. Enforces each account's own
`pharmacy_emergency_settings.retention_days` (1–365, `custom_035`) — the
patient-facing promise shown at consent time
(`EmergencyContraceptionPage.tsx` "保存期間 N日間"), which is shorter than and
takes precedence over the uniform 3-year rule for this one table.

Same fail-closed rules as the prescriptions job (unparseable `created_at` is
kept and counted separately, per-account `db.batch()`, one account's failure
never stops another, bounded to 100 intakes per account per tick), plus a
legal-hold check: an intake is never purged while its patient has an active
`pharmacy_data_subject_requests` row (`custom_038`) with `legal_hold = 1` and
no expired `legal_hold_release_at`. EC intakes carry no `patient_id` (PHI-minimal
by design), so the hold is matched on `(line_account_id, owner_friend_id)`.

**What "purge" means here is redaction, not row deletion.**
`pharmacy_emergency_intake_events` has an unconditional `BEFORE DELETE` trigger
(`pharmacy_emergency_events_no_delete`) that aborts every delete — including
ones a `FOREIGN KEY ... ON DELETE CASCADE` issues on the intake's behalf, since
SQLite fires a child table's `BEFORE DELETE` triggers for FK-cascaded deletes
too. Physically deleting the intake row is therefore impossible without
weakening that immutable-audit-trail guarantee, which this task does not do.
Instead the job clears the two columns that actually hold the patient's
answers — `encrypted_payload` (set to `''`) and `risk_flags_json` (set to
`'[]'`) — and leaves the row and its immutable event trail in place. `age_band`
and `safe_contact_mode` are left untouched: both are coarse, non-freeform
values with no PHI content once the payload is gone, and `age_band`'s `CHECK`
constraint has no "redacted" member to move to. The purge is logged in
`pharmacy_emergency_retention_purge_log` (`custom_049`) the same way — a new
table rather than widening `pharmacy_phi_retention_purge_log`'s `resource_type`
`CHECK`, which SQLite cannot `ALTER` without a rebuild the additive-only
migration policy forbids.

**Residual identifying data past `retention_days` (open question, not
resolved by NEXT-2).** Redacting `encrypted_payload` and `risk_flags_json`
only clears the self-declaration payload. Everything else on the row, and
every table that links back to it, is retained indefinitely today:
`owner_friend_id` (identifies the LINE friend), `age_band`, `safe_contact_mode`,
`product_code`, `status`, `slot_id`, `reference_code`, `created_at`/`updated_at`,
`reviewed_by`/`reviewed_at`, `closed_by`/`closed_at` on the intake row itself,
plus the immutable `pharmacy_emergency_intake_events` (`custom_035`),
`pharmacy_emergency_reminders` (`custom_047`), and
`pharmacy_emergency_intake_access_events` (`custom_044`) audit trails. Together
these still let a reader reconstruct "friend X consulted about EC on date Y,
age band Z" past the promised N days. Whether the patient promise requires
tombstoning `owner_friend_id` / `age_band` — which would need a migration and
a deliberate change to the no-delete audit invariant this document has
otherwise treated as fixed — is an open product question, not decided here.

`pharmacy_phi_retention_purge_log`
(`packages/db/migrations/custom_037_pharmacy_phi_retention_purge_log.sql`) records
`resource_id`, `r2_key`, the `age_reference_at` the boundary was measured
against, `retention_years`, and `purged_at`. It holds no PHI and carries no
foreign key to the purged row — a foreign key would either block the delete or
cascade the evidence away with it.

## Deferred to a follow-up task

Ordered by risk. None of these are fully enforced today (item 5 is
partially enforced — see below and the Enforced table).

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
3. **Incoming LINE chat images** (`tenants/{t}/accounts/{a}/incoming/`). The R2
   key is now tracked (`pharmacy_incoming_image_objects`, `custom_050`, commit
   e028b86): `webhook.ts` writes a row with `stored_at` best-effort alongside
   every incoming image, forward-only. What's still missing: no purge job reads
   this table yet, and there is no backfill for objects stored before
   `custom_050` — those still survive only as a URL inside `messages_log.content`
   JSON. Do not blind-delete by prefix age for the pre-`custom_050` set; there
   is no age reference on those objects that this repository owns.
4. **`messages_log` / `chats` / `friends`.** JST-formatted timestamps, so they
   need their own cutoff string — the UTC cutoff used above is wrong for them by
   9 hours, and mixing the two is exactly the kind of silent off-by-one that
   deletes live data. Also the largest row counts, so a bounded batching strategy
   matters more than for prescriptions.
5. **Emergency contraception (`custom_035`) — partially enforced, open
   question.** NEXT-2 (2026-08-22) enforces the account's own
   `pharmacy_emergency_settings.retention_days` (1–365) — shorter than 3 years
   and a patient-facing promise — but only for `pharmacy_emergency_intakes`'
   self-declaration payload (`encrypted_payload`, `risk_flags_json`, redacted
   in place). See "Emergency contraception retention" above for the residual
   identifying columns (`owner_friend_id`, `age_band`, status, and the
   event/reminder/access audit rows) this does **not** clear. Open question:
   does the patient promise require tombstoning `owner_friend_id` / `age_band`
   too? That would need a migration and a change to the no-delete audit
   invariant, and is a human product decision, not resolved here.
   `pharmacy_emergency_intake_events` remains unenforced: its immutable-delete
   trigger makes it structurally an audit table, so it is sequenced with item 7
   below, not with its parent.
6. ~~**`pharmacy_webhook_event_receipts` stragglers.**~~ **Resolved (NEXT-6,
   commit e663658).** `sweepWebhookInbox` dead-letters any `pending`/`processing`
   row older than 24h with no live lease; `purgeWebhookEventReceipts` then
   removes dead-lettered rows the same way it already removed `completed` ones,
   at 30 days. The fix was the queue bug, not a new raw delete — the principle
   that stuck rows must be fixed rather than blind-deleted held.
7. **Audit tables.** Sequencing question, not a mechanism question — they must
   outlive the data they describe. Decide the offset before implementing.
   `pharmacy_emergency_intake_events` joins this group (see item 5): its
   `BEFORE DELETE` trigger blocks any purge job today, deliberately.

## 3-year purge: deletion order spec (not implemented)

Derived from `packages/db/bootstrap.sql` FK declarations only (`grep -n
"REFERENCES\|ON DELETE"` per table, 2026-08-22) — nothing here is guessed.
"Depends on" = the table(s) this row's FK points at; those are deleted
**after** this row regardless of `ON DELETE CASCADE`, since the purge job
deletes leaf-first explicitly for auditability rather than relying on cascade.

| # | Table | Age ref col | Format | Cutoff helper | Depends on (deleted after) | Notes/blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `pharmacy_prescription_events` | `created_at` | Z | `retentionCutoff()` | submissions (CASCADE) | |
| 2 | `pharmacy_prescription_view_events` | `viewed_at` | Z | `retentionCutoff()` | submissions, files (both CASCADE) | |
| 3 | `pharmacy_prescription_validities` | `created_at` | Z | `retentionCutoff()` | submissions (CASCADE) | |
| 4 | `pharmacy_submission_sources` | `entered_at` | Z | `retentionCutoff()` | submissions (CASCADE) | |
| 5 | `pharmacy_submission_attributes` | `created_at` | Z | `retentionCutoff()` | submissions (CASCADE) | |
| 6 | `pharmacy_myna_verifications` | `created_at` | Z | `retentionCutoff()` | myna_handoffs (no CASCADE) | |
| 7 | `pharmacy_myna_events` | `occurred_at` | Z | `retentionCutoff()` | myna_handoffs (no CASCADE) | |
| 8 | `pharmacy_continuity_events` | `created_at` | Z | `retentionCutoff()` | continuity_obligations (no CASCADE) | |
| 9 | `pharmacy_next_intake_expectation_events` | `occurred_at` | Z | `retentionCutoff()` | next_intake_expectations (no CASCADE) | |
| 10 | `pharmacy_next_intake_expectations` | `created_at` | Z | `retentionCutoff()` | continuity_obligations, patients (no CASCADE) | |
| 11 | `pharmacy_medication_followup_events` | `occurred_at` | Z | `retentionCutoff()` | medication_followups (no CASCADE) | |
| 12 | `pharmacy_medication_followups` | `created_at` | Z | `retentionCutoff()` | patients, prescription_patients (no CASCADE) | |
| 13 | `pharmacy_continuity_obligations` | `created_at` | Z | `retentionCutoff()` | patients, submissions ×2 (no CASCADE) | `candidate_submission_id` can reference a **newer** submission than `source_submission_id` — its own deletion order is `unknown`, resolve before implementing |
| 14 | `pharmacy_prescription_expectations` | `created_at` | Z | `retentionCutoff()` | myna_handoffs, friends, patients, submissions (no CASCADE) | |
| 15 | `pharmacy_myna_handoffs` | `created_at` | Z | `retentionCutoff()` | friends, patients (no CASCADE) | |
| 16 | `pharmacy_prescription_patients` | `created_at` | Z | `retentionCutoff()` | submissions, patients, intake_responses (no CASCADE) | |
| 17 | `pharmacy_fulfillment_quotes` | `created_at` | Z | `retentionCutoff()` | submissions (no CASCADE) | |
| 18 | `pharmacy_print_tasks` | `created_at` | Z | `retentionCutoff()` | submissions (no CASCADE) | |
| 19 | `pharmacy_data_subject_requests` | `created_at` | Z | `retentionCutoff()` | patients (no CASCADE) | its child `pharmacy_data_subject_request_events` has its own immutable-audit `BEFORE DELETE` trigger (`pharmacy_data_subject_events_no_delete`); `unknown` whether a closed request row itself may be purged while that event trail must survive |
| 20 | `pharmacy_patient_intake_responses` | `created_at` | Z | `retentionCutoff()` | patients (no CASCADE); self via `base_response_id` (no CASCADE) | leaf-first within one patient's own revision chain |
| 21 | `pharmacy_prescription_submissions` | `created_at` | Z | `retentionCutoff()` | friends (no CASCADE) | root of the prescription aggregate; delete only after 1–5, 14, 16–18 |
| 22 | `pharmacy_patients` | `created_at` | Z | `retentionCutoff()` | friends (no CASCADE) | delete only after 10, 12, 13, 15, 16, 19, 20 |
| 23 | `messages_log` | `created_at` | **+09:00** | `retentionCutoffJst()` (not implemented) | friends (CASCADE) | only surviving pointer to incoming-image R2 keys (inside JSON `content`) — deleting the row without reconciling R2 first orphans the object (deferred item 3) |
| 24 | `chats` | `created_at` | **+09:00** | `retentionCutoffJst()` (not implemented) | friends (CASCADE) | |
| 25 | `friends` | `created_at` | **+09:00** | `retentionCutoffJst()` (not implemented) | — (root) | delete only after 21–24 |
| 26 | `pharmacy_emergency_intake_events` | `occurred_at` | Z | n/a | emergency_intakes (CASCADE, blocked) | **redact, not delete** — solely because `pharmacy_emergency_events_no_delete` `BEFORE DELETE` trigger aborts every delete including FK-cascaded ones; NEXT-2 only redacts the parent `pharmacy_emergency_intakes` row, it does not touch this table |
| 27 | `pharmacy_emergency_admin_events` | `occurred_at` | Z | n/a | — (audit) | **redact, not delete** — `pharmacy_emergency_admin_events_no_delete` `BEFORE DELETE` trigger aborts every delete, same shape as row 26 |
| 28 | `pharmacy_activity_notifications`, `platform_admin_access_events` | `created_at` | Z | `retentionCutoff()` | none blocking (only line_account/staff FKs) | audit-only; no `no_delete` trigger, but sequence **after** everything above per existing "audit-only" guidance |
| 29 | `pharmacy_emergency_sale_records` (custom_051) | `sold_at` | Z | `retentionCutoff()` | emergency_intakes (no CASCADE; owner match enforced by `pharmacy_emergency_sale_owner_match` BEFORE INSERT trigger, not a FK) | **redact, not delete** — `pharmacy_emergency_sale_records_no_delete` `BEFORE DELETE` trigger aborts every delete (same shape as row 26); a 3-year purge must instead redact `determination_encrypted` (set to `''`), leaving the statutory plaintext columns (`outcome`, `sold_at`, `product_code`, `identity_check`, `in_person_dose`, `pharmacist_staff_id`, `training_registration_number`, `checklist_sheets_received`) in place; legal-hold check joins via its own `owner_friend_id` column, not via `pharmacy_emergency_intakes` |

`pharmacy_emergency_intakes` itself is already **redact, not delete** (see
"Enforced" above, NEXT-2) — it is not in this table because it has a purge
job today. Implementing any row above is out of scope here; tracked as
2029+ V0.3x backlog per DoD.

# Pharmacy Growth Loop roadmap

Status (2026-08-19): Release 1 implementation, local verification, and
independent review evidence is retained from `feature/growth-loop-release-1`
(`707e04f`). The current integration branch is
`v0.26.0/feature/logical-multitenancy`; multitenant boundary work and LIFF
deployment-contract checks are local and uncommitted. The public dev LIFF/Admin
Pages still serve an older bundle, so no deployment, LINE setting, production
D1/R2 access, or production-data validation is claimed.

The runtime application packages and pharmacy release metadata are unified at
`0.25.0` on `dev`. The `pharmacy-v0.25.0` tag is a pending release action, not
deployment evidence. `minimum_client_version` and `rollback_compatible_from`
remain `0.21.3` as compatibility floors for existing customers; they are not
the current application version.

## Purpose

Release 1 moves the patient's first action toward this pharmacy's LINE intake,
measures whether the pharmacy kept its stated ready time, and creates a safe
foundation for continuity between visits. The pharmacy owns the patient
relationship.

## Non-purpose and rejected designs

- No pharmacy marketplace, comparison, ranking, or automatic referral.
- No AI, OCR, medication extraction, diagnosis support, or image inference.
- No inventory promise, regional inventory search, or prescription-content
  copy into LINE, analytics, or logs.
- No automatic electronic-prescription acceptance from a browser handoff.
- No claim that a reminder caused completion or that a message caused an
  unfollow.
- No production mutation or automatic rich-menu publication in this branch.

## A1-H1 feature matrix

`implemented` means local code and focused tests exist. It does not mean
deployed. `partial` means the listed residual surface remains open.

| ID | Product capability | Baseline reused | Release 1 evidence | Assessment | Residual / later work |
| --- | --- | --- | --- | --- | --- |
| A1 | Pharmacy mode allowlist | staff auth, LINE accounts, route/cron seams | `growth-loop/access.ts`, `generic-feature-guard.ts`, account capability migration and denial tests | partial | High-risk marketing routes/jobs are closed; remaining generic booking/event/Meet surfaces require a later bounded audit. |
| A2 | First-use onboarding | follow webhook and friend records | `onboarding.ts`; redelivery-safe first-follow event and approved welcome | implemented | Copy experiments are not Release 1. |
| B1 | Single intake entry | versioned pharmacy rich-menu generator | `rich-menu/profile.ts`; 2500x843 one-area profile targeting `pharmacy-receive` | implemented | Operator preview/create/publish remains a Human gate; old three-area profile stays available. |
| B2 | Issuer attribution | accepted prescription submissions | account-owned medical sources plus primary/other/unknown submission classification | implemented | OCR and personal QR correlation are rejected. |
| C1 | First/second activation | accepted submission events and family patient links | friend-level first intake plus patient-level first/second submission events and mature cohorts | implemented | Unlinked patient identity remains unknown rather than guessed. |
| C2 | Between-visit continuity | existing `custom/pharmacy/continuity` | reused as a future connection point; no new follow-up domain was duplicated | existing | MedicationFollowUp and NextIntakeExpectation are Release 2 contracts below. |
| D1 | Ready-time promise SLA | `FulfillmentQuote.estimated_ready_at` and prescription ready events | latest pre-ready quote revision, grace setting, on-time/late/p50/p90 metrics | implemented | Operational alerts are later work. |
| E1 | Prescription use period | prescription submission state | dedicated validity row, pharmacist verification, prior-day reminder, expired review queue, no automatic close | implemented | Per-account timezone beyond the Japan-only initial setting requires product clarification. |
| F1 | Automated notification guard | Harness proxy and existing pharmacy notifications | approved IDs, typed variables, final payload checks, PHI-free automated wrapper | partial | Manual chat is intentionally separate; any newly discovered generic automated path must be routed through the guard before being called covered. |
| G1 | Frequency and unfollow monitoring | follow/unfollow timestamps | proactive monthly cap, all-category counts, 24h/72h temporal association, `alert_only` enforcement | partial | Message-level causality is rejected; auto-pause requires the later gates below. |
| H1 | Release 1 dashboard | existing admin layout/components | account-scoped entry/source/SLA/validity/notification cards and JST month selection | implemented | Patient history is a separate local feature branch and is not evidence for this branch. |

## Current code map

```text
custom/pharmacy/growth-loop/
  access.ts                 account assignment and capability checks
  generic-feature-guard.ts generic UI/API/cron deny points
  onboarding.ts             first-follow onboarding and activation
  policy.ts                 approved automated-message contract
  sender.ts                 guarded, capped, idempotent LINE push
  validity.ts               due reminder claim/send/release processing
  repository.ts             sources, validity, KPI projections, audit batches
  routes.ts                 account-authorized admin API

custom/pharmacy/rich-menu/  versioned single-action profile and R2 storage
custom/pharmacy/*            existing prescription, quote, continuity, Myna flows
custom_008_*                 additive account, metric, source, validity tables
custom_020_*                 explicit staff-to-account backfill
custom_021_*                 tenant/account-scoped webhook redelivery receipts
```

The patient-history branch and the print/activity-notification branch remain
separate. Their tests or commits do not make Release 1 complete, and their
migrations must be rebased after `custom_008` before integration.

## Release 1 dependencies

1. `custom_001` through `custom_007` pharmacy schema and the existing
   prescription/quote/continuity/Myna state machines.
2. `staff_members` authentication plus explicit `pharmacy_staff_accounts`
   assignment. The installation `env-owner` remains an explicit global owner,
   but the target account must still exist and be active.
3. Existing Harness proxy retry keys and account-owned LINE credentials.
4. Existing rich-menu preview/create/publish and account-scoped R2 keys.

## Acceptance criteria

- Every new read/write includes `line_account_id`; non-owner staff need an
  active account assignment; cross-account tests deny access.
- Pharmacy mode fails closed in UI, API, webhook automation, and covered cron
  paths. Non-pharmacy tenants retain existing behavior.
- Follow redelivery sends one welcome; unblock does not resend by default.
- Single-action menu generation is account-idempotent and does not publish.
- Only the first accepted event per submission is counted; drafts and revision
  uploads are not submissions.
- Medical source unknown coverage and each denominator are visible.
- SLA uses the latest quote made before the first ready event; desired pickup
  time is never treated as the pharmacy promise.
- Unverified/unknown dates never trigger validity reminders. Expiry raises a
  staff review and never closes a submission automatically.
- Automated pharmacy messages accept only approved IDs and variables. A guard
  failure sends nothing and logs no rendered payload.
- Proactive non-care sends are capped per friend/account/month. Unfollow
  results are labelled estimated temporal association.
- Focused tests, migration replay/bootstrap checks, relevant builds, full
  repository tests where runnable, and an independent read-only review pass.

## Rollout gate

Rollout is blocked by any migration/bootstrap mismatch, cross-account access,
notification-policy bypass, duplicate send, invalid denominator, or blocking
review finding. A pharmacist/legal reviewer approves patient wording. An
operator separately approves production migration, account capability rows,
rich-menu publication, LINE settings, and deployment.

## Rollback conditions

- Disable the affected pharmacy capability for an application-level rollback.
- Restore the previous three-area rich menu by explicit LINE operator action.
- Stop validity reminder cron if duplicate or incorrectly timed sends appear;
  do not delete validity or audit history.
- Do not roll back an applied additive migration by dropping tables. Roll back
  code, preserve data, and ship a new additive corrective migration if needed.

## Human gates

- Pharmacist/legal approval of onboarding, reminder, expiry, and ready-time
  language.
- Production migration and central deployment approval.
- Account/staff assignments and pharmacy capability selection.
- Rich-menu preview and publication on each LINE account.
- Japan-only timezone assumption confirmation for Release 1.
- Retention period approval for events/exposure links.
- `alert_only` may not become auto-pause until the later contract is met.

## Release 2 document contract (no code in Release 1)

### MedicationFollowUp

This is separate from continuity. Candidate states are `scheduled`, `due`,
`delivered`, `no_issue`, `concern`, `pharmacist_requested`, `assigned`,
`responded`, `escalated`, `closed`, and `cancelled`. A pharmacist chooses the
patient and send date. New or changed medication may be a UI candidate, but the
system must not turn it into an automatic legal obligation. Patient-facing
automation remains PHI-free and non-AI.

### NextIntakeExpectation

Do not call this a dispensing reservation. Candidate states are `offered`,
`accepted`, `active`, `reminded`, `linked`, `fulfilled`, `paused`, and `ended`.
Before a valid prescription arrives, it cannot reserve medication or promise
dispensing. Timing comes only from pharmacist-entered supply days, a manually
entered expected window, or a future approved receipt-computer integration.
OCR/image inference is prohibited. Return metrics use `patient_id`, never the
family LINE friend alone, and immature expectations are not failures.

## Later inventory tracks

Inventory integration and regional inventory are separate releases. They need
an authoritative stock source, freshness/locking semantics, responsibility
boundaries, and pharmacist override before any patient-facing availability
claim. Release 1 contains no placeholder promise or hidden inventory model.

## Future auto-pause gate

Auto-pause remains rejected in Release 1. A later release needs an account and
category-specific minimum exposure, configurable threshold, consecutive
windows or hysteresis, manual re-enable, append-only audit, and a guarantee
that emergency/transactional care notifications cannot be paused.

# Pharmacy Growth Loop Release 1

Status: implementation work is local to `feature/growth-loop-release-1`.
No push, release, deployment, LINE configuration, or production data mutation is
part of this release.

## Purpose

Make the pharmacy LINE account the patient's default prescription intake, make
the pharmacy's promised ready time measurable, and create a useful contact
between visits. The pharmacy remains the only patient relationship owner. This
feature is non-AI, non-marketplace, and does not copy prescription or identity
data into analytics or LINE notifications.

## A1-H1 gap matrix

| ID | Capability | Current code | Release 1 result | Release 2/backlog |
| --- | --- | --- | --- | --- |
| A1 | Pharmacy mode | Pharmacy routes exist; no server allowlist | Account-scoped allowlist and deny tests | Broader generic-surface audit |
| A2 | First-use onboarding | Follow/friend storage exists | Idempotent pharmacy welcome and measurable cohort | Message experimentation |
| B1 | Single intake entry | Three-area pharmacy menu exists | Versioned one-action profile; old profile retained | Publish automation |
| B2 | Source attribution | Submission and event history exist | Manual primary/other/unknown source classification | QR/source correlation |
| C1 | First submission activation | Submission state exists | First/second accepted submission metrics | Return-rate cohort |
| C2 | Continuity | Continuity obligations exist | Dashboard projection only | Follow-up and next-intake expectation |
| D1 | Promise measurement | FulfillmentQuote has `estimated_ready_at` | Reproducible SLA metrics from quote + ready event | Operational alerts |
| E1 | Prescription validity | Quote validity exists but is not prescription validity | Dedicated validity model and staff review queue | System integration |
| F1 | Safe automated notifications | Pharmacy status pushes exist | Approved-template policy guard and PHI-free checks | More approved care templates |
| G1 | Frequency/unfollow | Follow/unfollow timestamps exist | Proactive cap and estimated exposure/unfollow metrics | Thresholded auto-pause |
| H1 | Release dashboard | Existing pharmacy admin pages exist | Account-scoped growth dashboard plus patient detail/history view | Advanced cohort views |

## Release 1 implementation order

1. SoT, KPI contract, and pharmacy boundaries.
2. Capability allowlist and tenant authorization.
3. Versioned single-action rich menu and onboarding/activation events.
4. Source classification, fulfillment SLA, and prescription validity.
5. Notification policy guard, proactive cap, and unfollow exposure metrics.
6. One account-scoped dashboard and integration/adversarial tests.

Exactly one item is WIP at a time; the next item starts only after its focused
test and relevant build pass.

## Release 2 contract (document only)

`MedicationFollowUp` and `NextIntakeExpectation` remain separate from existing
continuity. They require pharmacist-selected targets, explicit expected windows,
patient-level (not friend-level) cohorts, and no treatment or dispensing
promise before a valid prescription is received. OCR, AI, stock integration,
patient export, QR-person correlation, and PDF generation remain out of scope.

## Rollout and rollback gates

- New rich-menu profiles are prepared only; publishing remains an explicit
  operator action and the old three-area profile remains recoverable.
- New tables are additive and replay-safe. No applied migration is edited.
- Automated pharmacy pushes fail closed when the policy cannot render or
  validate a message; staff manual chat remains a separate audited path.
- A failed migration, tenant-isolation test, or PHI policy test blocks rollout.
- Production D1/R2/LINE settings and deployment require a separate human gate.

## Human gates

Pharmacist/legal review is required for patient-facing wording and validity
reminder wording. An operator must approve production migration, rich-menu
publishing, LINE account settings, and any future move from `alert_only` to
`auto_pause`.

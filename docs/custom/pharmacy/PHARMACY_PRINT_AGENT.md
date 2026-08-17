# Pharmacy print contract

## Release 1: staff-controlled browser printing

The Worker never connects to a USB or network printer. After a prescription
submission reaches `received`, the caller invokes
`enqueuePrescriptionPrintJobs(db, lineAccountId, submissionId)`. The service
creates one account-scoped job per ready file in the active revision. Repeating
the call is safe because `(line_account_id, submission_id, file_id, revision)`
is unique.

The admin UI uses the existing account-scoped prescription detail and image
endpoints. It renders only the active ready revision and calls
`window.print()` after an explicit staff click. No silent or unattended print
is attempted in the browser.

Queue API:

- `GET /api/custom/pharmacy/print/jobs?line_account_id=...&status=queued&limit=100`
  returns opaque job/file IDs and state metadata only.
- `POST /api/custom/pharmacy/print/jobs/:id/claim?line_account_id=...`
  claims one job for the authenticated staff member.
- `POST /api/custom/pharmacy/print/jobs/:id/printed?line_account_id=...`
  records an explicit successful print.
- `POST /api/custom/pharmacy/print/jobs/:id/failed?line_account_id=...` with
  `{ "code": "printer_unavailable" }` records a fixed failure code and
  schedules a bounded retry.
- `POST /api/custom/pharmacy/print/jobs/:id/retry?line_account_id=...`
  manually requeues a failed, dead-letter, or superseded job.

All routes require staff authentication and verify account membership. The
JSON contract never includes an R2 key, patient name, prescription text, drug
name, or free-form error. Print audit events contain only state, fixed failure
codes, actor type/ID, attempts, and timestamps.

## Future resident-agent extension

An in-pharmacy agent is deliberately not required for Release 1. If it is
added, the agent must use a per-pharmacy credential and a short-lived signed
URL containing only an opaque job ID and account claim. The Worker should
resolve the private R2 key server-side, stream the object with `private,
no-store`, and never return the key to the agent. Claim ownership, lease
expiry, acknowledgement, fixed-code failure, retry limits, and append-only
audit events remain the same as the staff API.

The agent must not emit image bytes, R2 keys, patient names, medication data,
tokens, or raw printer errors to logs. Provisioning, credential rotation,
printer permissions, and unattended retry policy require a separate security
review before implementation.

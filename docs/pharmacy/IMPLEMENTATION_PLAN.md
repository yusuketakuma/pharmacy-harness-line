# Pharmacy Harness Line Implementation Plan

Status: logical multi-tenancy is under local implementation on
`v0.26.0/feature/logical-multitenancy`. Worker, DB, LIFF, and Admin focused
tests/builds pass locally, including the additive `custom_022` integrity
triggers. The currently public dev LIFF/Admin Pages still serve an older bundle
(the multitenant asset contract is not present). No deployment was run in this
task. Production data and settings were not read or mutated.

The former per-customer repository and per-customer Cloudflare delivery model
is retired. Its GitHub update workflows, customer onboarding scripts, tenant
self-update API, and tenant update UI are not part of this product topology.

## Current architecture

```text
dev -> main -> central CI/CD -> one Cloudflare application
                                      |
                                      +-- tenant-scoped staff sessions
                                      +-- tenant-scoped LINE accounts
                                      +-- tenant-scoped D1 records
                                      +-- tenant/account-scoped R2 keys
```

The base OSS installer and update-engine packages may remain for upstream tool
compatibility, but pharmacy tenants cannot invoke them through the Worker or
admin dashboard.

## Required invariants

- Every authenticated admin request has one server-verified tenant context.
- Request query/body account IDs are selectors, never authorization evidence.
- Every tenant-owned query is constrained by the authenticated tenant or by a
  resource relationship that resolves to it.
- LINE webhook and LIFF identities resolve an active tenant/account mapping.
- R2 patient objects use tenant/account prefixes and private authenticated reads.
- Cron jobs operate only on active tenant-mapped accounts; pharmacy mode keeps
  generic CRM jobs fail-closed.
- Applied migrations are never edited. New schema changes use additive
  `custom_NNN` migrations.
- Automated pharmacy notifications remain PHI-free.

## Central deployment contract

- Only the platform release workflow deploys Worker/Admin/LIFF.
- Tenant administrators cannot call infrastructure update endpoints.
- D1/R2/Secrets bindings are verified before and after deployment.
- Migration approval, backup/bookmark evidence, smoke tests, and rollback remain
  platform human gates.
- Deploying code must not recreate, overwrite, or detach tenant mappings,
  staff memberships, LINE configuration, D1 records, or R2 objects.

## Current local evidence

- `custom_014_pharmacy_logical_tenants.sql` introduces tenant, account mapping,
  and staff membership tables with conservative backfill.
- Admin login binds a pharmacy code to an authorized tenant membership.
- LINE account APIs, LIFF resolution, webhook account resolution, prescription
  images, incoming images, token refresh, and selected cron paths have tenant
  boundary tests. `custom_020` backfills explicit staff-to-account assignments;
  `custom_021` makes LINE webhook redelivery receipts tenant/account scoped.
- Generic customer repository update automation and tenant self-update controls
  are removed locally.
- An earlier permitted dev smoke check recorded healthy Worker/CORS responses
  and HTTP 200 for the Admin and LIFF Pages. The current public dev LIFF asset
  audit, however, found an older bundle without the multitenant pharmacy build
  marker; dedicated Pages topology and current Admin/LIFF asset deployment are
  therefore not currently verified.
- The additive `custom_014` through `custom_022` migrations and generated
  bootstrap pass local schema, replay-ledger, and checksum checks. A raw replay
  of `custom_016` against an already-generated bootstrap is not a supported
  deployment operation because it contains `ALTER TABLE`; the migration ledger
  prevents that reapplication in a live upgrade. No D1 mutation was performed
  in this task, so live development or production application state remains a
  separate human gate.

See `docs/pharmacy/MULTITENANT_OWNERSHIP_MATRIX.md` for the explicit
ownership/deny matrix and residuals. This is still partial deployment evidence:
local tests do not prove live Pages freshness, D1 migration state, R2/Secrets
preservation, or LINE rich-menu publication.

## v0.35 pharmacist review concurrency contract (2026-09-05)

- Existing submission source `POST` and validity `PUT` accept an additive
  `expectedUpdatedAt` field: an ISO timestamp matches that review row, and
  explicit `null` requires the row to be absent. Omission retains the previous
  client contract; it does not prove stale-write protection for old clients.
- The new Admin sends the version from the start of editing, not a background
  refresh. A conflicting save returns HTTP 409 with the existing
  `{ success: false, error }` envelope, changes neither review nor audit, and
  never automatically replays a mutation. Same-millisecond saves must still
  advance the stored version.
- Admin preserves the draft, displays the conflict, and requires an explicit
  reload/discard before taking the new version as an editing base. Source and
  validity are separate review records. Account/staff authorization, immutable
  clinical status history, and PHI-free audit remain mandatory.
- Rollout is Worker first, then Admin; old Admin continues to function with the
  new Worker. An old Worker ignores the added field and cannot establish the
  new concurrency guarantee. This guarantee requires current Worker evidence;
  mixed-version compatibility is not a release-readiness claim.

The existing prescription detail response also adds optional `intake` metadata
(linked/latest revision and submission time, review time), scoped to the
submission/account/owner/patient tuple. No answers or encrypted payloads are
projected. Missing fields from an old Worker mean unverified, not no intake.
The historical `patient_display_name` field remains the LINE friend's display
name; Admin explicitly labels it as such rather than treating it as identity.

Fulfillment quote POST additionally accepts optional `expectedRevision` (a safe
non-negative integer; zero requires no existing quote). Omission preserves old
clients. The append checks the latest account/submission revision and allowed
submission state atomically; conflicts retain the existing HTTP 409 `{ error }`
contract. A quote and its linked Myna event commit together or neither commits.
Admin retains the editing revision across refresh, preserves failed drafts, and
requires explicit discard/reload before retry. This guarantee likewise requires
the new Worker; it cannot be claimed while an old Worker serves the request.

The quote/event rollback relies on the native D1 `batch()` transaction contract:
[Cloudflare D1 database methods](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Local SQLite tests execute the shipped quote/event schema and actual statements;
they are not deployed D1 or LINE evidence. Staff quote inputs and displayed
prescription timestamps use Asia/Tokyo regardless of the device time zone.

## v0.35 beta admission preparation (NOT_IMPLEMENTED, 2026-09-06)

The existing LINE identity, consent, proxy permission and account capability
checks do not establish invitation membership. The initial one-pharmacy,
five-person cohort is still a proposal, not an activated restriction. The human
choice between self-only patients and authorized family patients is pending;
the membership key and migration are not implemented before that choice.

The following operation boundaries are preparation for V035-5, not current
runtime guarantees or authorization to activate a beta account:

- Public pharmacy information, privacy explanations, withdrawal/contact-stop,
  proxy revocation and data-subject rights remain available through their
  existing identity/authorization checks; no blanket beta middleware may hide
  these routes.
- New patient work, expanding an existing case, resubmission and follow-up
  answers require a current membership decision in addition to the existing
  account/patient/consent/proxy checks. Existing-record reads and staff terminal
  drain need an explicit operation matrix so that withdrawal does not orphan
  an ongoing clinical case. Whether a particular continuation is permitted is
  decided with the pharmacy owner, not inferred from a valid LINE token.
- Public LINE chat can still arrive from non-participants. Receiving a message
  must not enroll the sender in beta clinical work. Its existing retention,
  ordinary-consultation response and responsible staff remain separate.
- Membership must be checked in the write transaction, not only before an
  awaited operation. An upload that stages bytes before revocation needs its
  existing safe staging/reconciliation path; no production delete is implied.
- Queued work must retain the membership generation under which it was
  authorized, and recheck current membership before dispatch. Regranting must
  not resurrect an older queued notification. A provider call already in
  flight cannot be promised cancellable; the stop boundary and unknown-outcome
  reconciliation must be explicit before activation.
- Preserve existing route/field meanings and omitted-field behavior. An old
  Worker does not know a new admission rule: an activated beta cannot safely
  roll back merely by switching that rule off. Prove a compatible hard-stop
  path covering old create/resubmit/jobs, or retain the new Worker and forward
  fix. Missing admission schema must not silently reopen an enabled beta.

The local readiness evidence lists the current tests and the uncompleted
human/operations gates. No invitation, membership write, migration, LINE
mutation, deployment or production operation has been performed for V035.

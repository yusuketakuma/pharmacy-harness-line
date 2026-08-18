# LINE Harness Pharmacy Implementation Plan

Status: the prescription/continuity foundation is locally verified. Growth Loop
Release 1 is being implemented on `feature/growth-loop-release-1` from `dev`;
the Growth Loop work is not pushed, merged, released, or deployed. The
account-scoped patient detail/history view and print/activity inbox are separate
local feature branches and are not completion evidence for this branch.

Current evidence is intentionally separated: live source and tests prove local
implementation; `pharmacy-v0.23.1` is the latest pharmacy release metadata in
this checkout; no deployment evidence for Growth Loop Release 1 was inspected
or created. No real customer repository, Cloudflare environment, LINE account,
or production resource has been changed in this work.

The Release 1 source of truth is
[`docs/custom/pharmacy/GROWTH_LOOP_ROADMAP.md`](custom/pharmacy/GROWTH_LOOP_ROADMAP.md)
and its KPI definitions are in
[`docs/custom/pharmacy/GROWTH_LOOP_KPI_CONTRACT.md`](custom/pharmacy/GROWTH_LOOP_KPI_CONTRACT.md).

This document is the implementation contract for the pharmacy prescription
pre-send feature, customer delivery, and customer repository updates. The live
repository and tests remain authoritative when this document and code differ.

## 1. Completion definition

The project is complete only when every requirement below has implementation
evidence and its listed tests pass. A feature branch, a green narrow test, or a
successful deployment does not prove the whole plan complete.

| ID | Requirement | Required evidence |
| --- | --- | --- |
| DIST-01 | A customer receives the full program by cloning a seller release to a local checkout. | Synthetic private seller/customer repositories prove the clone and exact tag SHA. |
| DIST-02 | Onboarding changes the checkout to customer `origin` plus read-only seller `vendor` without copying secrets. | Unit tests for remote planning and an isolated repository integration test. |
| DIST-03 | The existing setup CLI runs from the customer checkout and uses customer-owned Cloudflare/LINE resources. | Installer contract tests and a synthetic onboarding run; no real patient data. |
| UPD-01 | Seller releases contain an immutable source commit and update policy metadata. | Manifest tests plus release workflow contract tests. |
| UPD-02 | A customer workflow fetches only the configured seller repository/tag and preserves merge ancestry. | Synthetic Git repository integration tests. |
| UPD-03 | Compatible releases create a PR and may auto-merge only after required checks. | Policy unit tests and workflow contract tests. |
| UPD-04 | Breaking/configuration/permission/conflicted/failed updates stop for manual approval. | Policy boundary tests and synthetic failure cases. |
| UPD-05 | Customer `main` deploys with customer secrets while the seller never receives Cloudflare/LINE secrets. | Workflow permission/secret contract tests. |
| DEP-01 | PR validation is secretless and cannot deploy, approve, or bypass policy. | Parsed workflow tests and synthetic PR evidence. |
| DEP-02 | One release orchestrator builds everything before mutation, serializes each environment, then deploys Worker before Admin/LIFF. | Workflow DAG tests and isolated deployment evidence. |
| DEP-03 | Every migration is checksum-bound, single-writer, crash-safe with its ledger record, and manually approved. | Migration runner tests including interrupted/replayed/concurrent cases. |
| DEP-04 | Each deployment records exact source/release SHA, migration set, D1 bookmark, Worker/Pages IDs, smoke result, and rollback eligibility. | Persisted release evidence from synthetic deployment. |
| RX-01 | Pharmacy product code is contained in runtime-local `custom/pharmacy/prescriptions` directories except marked registration seams and migrations. | Boundary test enumerating allowed paths and seam markers. |
| RX-02 | A LINE-authenticated patient can create one account-scoped draft and upload 1-4 valid ordered images. | Worker route tests, D1 tests, R2 stubs, and LIFF component tests. |
| RX-03 | Submission is idempotent and never exposes another friend/account's submission or image. | Replay, cross-friend, cross-account, and image authorization tests. |
| RX-04 | Patient acknowledges original-prescription and non-guarantee notices before submission. | Validation tests and accessible LIFF UI tests. |
| RX-05 | Patient sees no-thumbnail history, may cancel while unreviewed, and may replace the complete image set after a resubmission request. | State, revision atomicity, and LIFF history tests. |
| RX-06 | Admin sees an account-scoped queue, counts, oldest wait, private images, guarded actions, and existing chat link. | Worker/admin tests including stale write and cross-account denial. |
| RX-07 | Status notifications are automatic/external; pharmacist one-to-one replies remain manual. | LINE proxy attribution tests and failure-isolation tests. |
| RX-08 | Stale drafts and expired retained images are deleted idempotently without deleting active revisions. | Cleanup unit/integration tests and cron registration test. |
| RX-09 | Development E2E covers mobile submission through admin completion using synthetic images. | Recorded dev Worker/Admin/LIFF smoke and mobile E2E results. |

## 2. Non-goals

The first release does not include OCR, medication extraction, stock checks,
payments, generic form storage, health-state tags, new staff permission models,
configurable message templates, or a seller dashboard for all customers.

## 3. Repository and branch topology

```text
official OSS main
       |
       v
seller upstream PR -> seller dev -> seller main -> pharmacy-vX.Y.Z release
                                                  |
                                                  v
customer vendor/update-pharmacy-vX.Y.Z -> customer PR -> customer main
                                                   |
                                                   v
                                          customer Cloudflare
```

- Seller work branches from `dev` and enters `dev` by PR.
- `dev` deploys only to the isolated development environment.
- A release PR promotes `dev` to `main` and includes a reviewed version/policy
  change in `customer-release.json`.
- The existing release pipeline is reused, while seller tags use
  `pharmacy-vX.Y.Z` so future official `vX.Y.Z` tags cannot collide. Manifest
  versions remain plain SemVer for the existing update engine.
- Seller `main` merge starts the customer release automatically. A small
  seller-only workflow validates `customer-release.json`, creates the exact
  `pharmacy-vX.Y.Z` tag, and explicitly dispatches the existing release workflow at
  that tag. It does not rely on a `GITHUB_TOKEN`-created tag event to trigger a
  second workflow because GitHub suppresses most recursive token events.
- Customer update PRs use merge commits. Squash merging is forbidden because
  it discards seller ancestry and makes later updates conflict repeatedly.
- Customers never run `update-from-upstream.yml`. That workflow is seller-only,
  imports official OSS into seller `dev`, and is guarded by an explicit seller
  repository variable. Customer updates consume seller releases only.
- Production hotfixes branch from seller `main` and are merged back to `dev`.

## 4. Customer delivery and update design

### 4.1 Initial local delivery

The customer clones a reviewed immutable seller tag. The checkout immediately
contains the full program. Onboarding then:

1. verifies a clean checkout at the selected tag;
2. records the seller URL as `vendor` fetch-only;
3. configures the customer private repository as `origin`;
4. pushes the same history to customer `main`;
5. installs the customer update workflow;
6. uses the existing setup CLI from this checkout;
7. configures GitHub Environments with customer-owned values;
8. performs synthetic health, login, LIFF, and webhook checks.

The local computer is not part of later updates and may remain offline.

### 4.2 Reuse before new code

- Reuse `packages/create-line-harness/src/steps/clone-repo.ts` support for the
  current checkout, `LINE_HARNESS_REPO_URL`, and `--repo-dir`.
- Use `--from-source` for the first custom-source MVP. Do not route the custom
  fork through the official OSS manifest.
- Add one small onboarding command to the existing `create-line-harness`
  package only after the repository transformation is proven by standalone
  pure functions and synthetic Git tests.
- Never persist Cloudflare tokens, LINE secrets, API keys, or GitHub tokens in
  tracked files or command output.

### 4.3 Seller release metadata

Extend the existing release entry with one optional nested field rather than
inventing another manifest. Optionality keeps old official manifests readable:

```ts
type CustomerUpdateClass = 'compatible' | 'manual';

interface CustomerSourceUpdate {
  release_id: string;
  release_sequence: number;
  repository: string;
  commit: string;
  previous_commit: string;
  tag: string;
  update_class: CustomerUpdateClass;
  manual_reasons: string[];
  required_configuration: string[];
  privileged_paths: string[];
  new_migrations: string[];
  migration_digests: Record<string, string>;
  minimum_client_version: string;
  rollback_compatible_from: string;
  revoked: boolean;
}

interface ReleaseEntry {
  // existing fields remain unchanged
  customer_source_update?: CustomerSourceUpdate;
}
```

The release workflow derives `repository`, `commit`, and `tag` from GitHub
context. Release authors supply version and policy through a reviewed
repository file, `customer-release.json`, so arbitrary tag pushes cannot
silently classify a breaking update as compatible. A seller-only
`customer-release.yml` runs on `main`, creates the declared tag if it does not
already exist, and invokes `release.yml` through `workflow_dispatch` at that
tag. The release job validates:

- tag version equals package/release version;
- source commit is reachable from seller `main`;
- `previous_commit` is the prior published seller release and sequence strictly
  increases;
- `manual_reasons` is empty only for `compatible`;
- `new_required_secrets`, `required_configuration`, workflow permission
  changes, and breaking migrations force `manual`;
- compatible releases publish after all release checks; manual releases remain
  drafts until reviewed and published.

### 4.4 Customer update workflow

MVP is a staggered customer-side scheduled and `workflow_dispatch` workflow.
No vendor-controlled GitHub App is installed in customer repositories. It uses:

- one per-customer read-only credential restricted to seller repository
  contents;
- a separate customer-controlled mutation credential for its own branch and PR
  only; the seller-read identity and customer-write identity are never the same;
- no Cloudflare or LINE secret in the update job;
- pull-request CI has read-only contents permission and receives no deployment
  Environment, Cloudflare, LINE, admin, or production secret;
- a concurrency group so only one vendor update runs per customer;
- full Git history for ancestry checks.

Algorithm:

1. Download the latest published release entry from the configured seller.
2. Validate repository identity, tag format, commit SHA, update class, and
   current version.
3. Read `.line-harness-vendor.json` from customer `main` to obtain `Vprev`.
4. Fetch the exact tag and verify it resolves to declared `Vtarget`, `Vprev` is
   an ancestor of `Vtarget`, and `Vprev` remains an ancestor of customer
   production `main`.
5. Reject revoked releases, replay, downgrade, history rewrite, and unsupported
   client versions.
6. Exit successfully without a branch when already current.
7. Create `vendor/update-pharmacy-vX.Y.Z` from current customer `main`.
8. Merge the exact seller tag with `--no-ff`; never execute code from the
   update branch before the repository's trusted base workflow decides what
   to run.
9. Write the target release identity to `.line-harness-vendor.json` in the
   candidate merge and verify both `Cbase` and `Vtarget` are its ancestors.
10. Push the branch and open or reuse one PR to customer `main`.
11. Label compatible/manual status.
12. CI validates the exact merge candidate against current protected `main`.
13. Initially leave every production PR for client-controlled approval. After
   canary evidence, `CUSTOMER_UPDATE_MODE=compatible-auto` may enable auto-merge
   only for the narrow eligible class below. Otherwise leave the PR open.

The following changes force manual approval permanently:

```text
.github/**
CODEOWNERS
scripts/release/** and deployment/update scripts
package.json and pnpm-lock.yaml
packages/db/**
Worker wrangler configuration or bindings
authentication, session, authorization, or CSRF code
LINE scopes, callbacks, or permission configuration
configuration and secret schemas
outbound network or telemetry destinations
```

Every migration is manual even when additive. Narrow compatible auto-merge is
limited to non-privileged application changes with no dependency, migration,
permission, binding, configuration, authentication, or new egress change.
`customer-release.json` is the validated, non-executable seller release
description and is not itself a customer runtime privilege; its schema,
sequence, ancestry, classification, and required configuration are validated
separately at release and customer-consumption boundaries. All Worker runtime
source changes remain manual so path naming cannot hide a new egress or
authorization behavior.
The client base branch owns `CODEOWNERS` and the policy workflow; update PRs
cannot remove their own review requirement.

### 4.5 Secretless PR validation

All update PR checks:

- use read-only `GITHUB_TOKEN` and no deployment Environment;
- receive no Cloudflare, LINE, D1, R2, admin, production, or seller-read secret;
- cannot approve, merge, deploy, mutate Environments, or bypass rulesets;
- run an always-executed client-base policy job; a skipped job is not a gate;
- pin third-party GitHub Actions to immutable full commit SHAs;
- validate ancestry, manifest, lockfile, builds, API compatibility, migration
  classification, privileged paths, generated artifacts, bindings, variables,
  and outbound destinations.

Lexical `toContain` workflow tests remain smoke tests only. New tests parse YAML
and assert the active permissions, triggers, environments, needs graph, and
concurrency settings.

### 4.6 Deployment and migration

- Replace independent production mutation with one orchestrator per customer
  environment and exact merged source SHA. Existing Worker/Admin workflows
  become reusable jobs or lose their independent push mutation triggers.
- Use one cross-workflow concurrency key per repository/environment with
  `cancel-in-progress: false`.
- Install, build Worker/LIFF/Admin, run tests, validate configuration, and
  prepare artifacts before the first D1 mutation.
- Enter one customer-controlled production approval immediately before the
  first mutation for every manual release and every migration release.
- Record a D1 Time Travel bookmark before migration.
- Apply approved migrations through a single-writer runner. Fail closed when an
  existing schema lacks a trustworthy ledger; checking only `line_accounts` is
  not baseline proof.
- Store migration filename plus SHA-256 digest. Applied migration contents are
  immutable. Execute migration SQL and its ledger insert in one D1 request/
  transaction boundary and handle ambiguous responses by rereading ledger and
  digest before retry.
- Deploy the backward-compatible Worker/API, run synthetic API/D1/R2/auth/
  webhook smoke checks, then publish LIFF/Admin artifacts built from the same
  SHA, then run final smoke checks.
- Every release preserves old Worker + expanded schema, new Worker + expanded
  schema, new Worker + previous Admin/LIFF, and cached previous UI compatibility.
- New Admin screens still treat prescription API 404/503 as a temporary state.
- A failed update PR never reaches customer `main` and therefore never
  deploys.

### 4.7 Rollback and release evidence

Application rollback never automatically rolls schema back. Code rollback is
allowed only when the recorded prior version is certified compatible with the
current forward schema; otherwise pause and forward-fix. D1 Time Travel is a
separately authorized incident recovery, never an automatic deployment step.

Extend the existing `update_history` mechanism to persist PHI-free release
evidence containing source and vendor SHAs, migration names/digests,
pre-migration D1 bookmark, previous/new Worker version IDs, previous/new Pages
deployment IDs, smoke results, update class, and rollback eligibility. Do not
create a second deployment-history subsystem. No application logs, D1 query
results, patient identifiers, or prescription content enter fleet/update
metadata.

### 4.8 Scaling trigger

Scheduled customer pull is the MVP. Add a notification-only GitHub App fan-out
only when update latency or maintaining per-customer read credentials becomes
measurably expensive. Polling remains recovery. The App never receives
contents/PR/check/deployment/environment/secret/admin/bypass authority or any
customer Cloudflare/LINE secret, and its event is an untrusted hint that the
client independently verifies.

## 5. Prescription feature design

### 5.1 File boundary

```text
apps/worker/src/custom/pharmacy/prescriptions/
  state.ts
  image.ts
  repository.ts
  routes.ts
  cleanup.ts
  *.test.ts

apps/liff/src/custom/pharmacy/prescriptions/
  api.ts
  PrescriptionPage.tsx
  PrescriptionHistoryPage.tsx
  *.test.tsx

apps/web/src/custom/pharmacy/prescriptions/
  api.ts
  PrescriptionQueuePage.tsx
  *.test.tsx

apps/web/src/app/prescriptions/page.tsx
  thin re-export only

packages/db/migrations/custom_001_pharmacy_prescriptions.sql
```

Start with fewer feature files and split only when tests show one module has
multiple responsibilities. The tree above is a maximum intended shape, not a
scaffolding requirement.

Allowed upstream-owned seams:

- Worker route import/mount and scheduled cleanup call in `apps/worker/src/index.ts`.
- LIFF route import in `apps/liff/src/App.tsx`.
- Admin thin route and one sidebar item/badge.
- Environment CORS allow-header changes only if the real request requires it.

Every seam is marked `custom:pharmacy-prescriptions` and covered by a boundary
test. No generic tags, forms, automations, scoring, metadata, or public image
routes store prescription state.

### 5.2 Data model

Use three dedicated tables.

`pharmacy_prescription_submissions`:

- `id` primary key;
- `line_account_id` and `friend_id` tenant/owner boundary;
- `idempotency_key` with unique `(line_account_id, friend_id, idempotency_key)`;
- status: `draft`, `received`, `needs_resubmission`, `accepted`, `ready`,
  `closed`, `cancelled`;
- `active_revision` and `upload_revision`;
- optional `desired_pickup_at`;
- consent timestamps;
- fixed `resubmission_reason_code` only;
- `requested_at`, `closed_at`, `created_at`, `updated_at`.

`pharmacy_prescription_files`:

- `id`, `submission_id`, `revision`, and ordered `position`;
- private `r2_key`, `content_type`, `byte_size`;
- state: `pending`, `ready`, `deleted`;
- unique `(submission_id, revision, position)` and unique `r2_key`.

`pharmacy_prescription_events`:

- immutable status/revision audit event;
- submission, actor type/id, from/to state, fixed reason code, timestamp;
- no prescription text or image data.

All migration changes are additive. Update `schema.sql`, generate
`bootstrap.sql` and `bootstrap-meta.json` with the existing generator, and
prove bootstrap/replay equivalence.

### 5.3 Patient API

All patient endpoints extend the existing LINE verification root so it returns
both `lineUserId` and the matched `loginChannelId`. The existing
`verifyCallerLineUserId` remains a compatibility wrapper for current callers.
Prescription routes resolve the `liffId` account and require its
`login_channel_id` to equal the verified channel before querying a friend.
Friend lookup is strict `(line_user_id, line_account_id)` with no global
fallback. The endpoints are explicit method-aware exceptions in auth
middleware; no broad `/api/custom` or `/api/liff/pharmacy` bypass is allowed.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/liff/pharmacy/prescriptions` | Reserve idempotent draft and upload revision. |
| PUT | `/api/liff/pharmacy/prescriptions/:id/files/:position` | Upload one binary image for the current upload revision. |
| POST | `/api/liff/pharmacy/prescriptions/:id/submit` | Atomically validate 1-4 ready contiguous files and move to `received`. |
| GET | `/api/liff/pharmacy/prescriptions/me` | No-thumbnail history for the verified friend/account. |
| POST | `/api/liff/pharmacy/prescriptions/:id/cancel` | Cancel only patient-cancellable state. |
| POST | `/api/liff/pharmacy/prescriptions/:id/resubmission` | Reserve next revision only from `needs_resubmission`. |

Upload rules:

- JPEG and PNG only for MVP;
- declared type must match magic bytes;
- maximum 10 MiB per image and 4 images per revision;
- require `Content-Length` when available and always enforce actual bytes;
- create the pending D1 file row before R2 put;
- mark ready only after successful R2 put;
- sanitize keys and never include LINE user ID, display name, or health data;
- R2 key shape: `custom/pharmacy/prescriptions/<submission>/<revision>/<file>`;
- retrying the same position is idempotent only when content hash/size match;
- failure leaves a recoverable pending row, never a falsely ready file.

Submission requires both consent flags and 1-4 contiguous ready images. A
resubmission does not replace `active_revision` until the entire new revision
successfully finalizes. The old active revision remains available to staff
during a failed replacement.

### 5.4 State machine and concurrency

```text
draft ---------> received -------> accepted -------> ready -------> closed
  |                 |                  |
  |                 +-> needs_resubmission
  |                           |
  +-> cancelled              +-> received (new revision)

received -> cancelled (patient before staff review)
admin cancellation may move any nonterminal operational state -> cancelled
```

Every state mutation includes `expected_updated_at` and executes a
tenant-scoped conditional update. Zero changed rows returns 409. The event row
is written in the same D1 batch/transactional operation as the state change.
R2 and LINE calls occur outside the D1 atomic boundary and use explicit
compensation/retry states.

### 5.5 Admin API and UI

Admin routes use existing staff cookie/Bearer auth and CSRF protection.
`line_account_id` is required for every list, count, detail, image, and mutation
query.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/custom/pharmacy/prescriptions` | Account-scoped queue with filters/cursor. |
| GET | `/api/custom/pharmacy/prescriptions/stats` | Pending count and oldest wait. |
| GET | `/api/custom/pharmacy/prescriptions/:id` | Detail and event history. |
| GET | `/api/custom/pharmacy/prescriptions/:id/files/:fileId` | Authenticated `no-store` image stream. |
| POST | `/api/custom/pharmacy/prescriptions/:id/actions/:action` | Guarded CAS action. |

The admin page reuses `useAccount`. It provides:

- queue tabs and counts;
- oldest waiting age;
- status, requested time, desired pickup time, and fixed reason labels;
- image viewer with semantic buttons, keyboard operation, zoom, rotate, and
  no persistent browser cache;
- action confirmation and stale-write refresh;
- existing chat deep link by friend ID;
- a temporary retry state for API 404/503 during deployment;
- no prescription thumbnails in the queue.

### 5.6 Notifications

Commit the state first, then send best-effort LINE notification through the
existing local LINE proxy path. Automatic status notifications omit
`X-Line-Harness-Source: manual`, therefore persist as automatic/external.
Pharmacist free-text replies continue through existing chat and retain the
manual header. Notification failure never rolls back a valid state change; it
records a PHI-free failure event/status for retry.

### 5.7 Retention and cleanup

The user's instruction to implement the complete reviewed plan adopts this v1
retention policy:

- purge abandoned draft objects after 24 hours;
- purge images immediately after patient cancellation;
- purge images 30 days after `closed` or admin `cancelled`;
- retain only PHI-free operational event metadata after image purge.

Cleanup selects bounded batches, marks candidates conditionally, deletes R2
objects, then records deletion. It is idempotent and never deletes the active
revision of a nonterminal submission. Register it on the existing six-hour
cron; do not add a new Cron Trigger.

## 6. TDD delivery slices

Each slice follows Red -> Green -> Refactor and reruns affected tests after its
final edit. Each branch is based on current `dev` and merged to `dev` by PR.

### Slice A: `feature/client-release-metadata`

Red tests:

- release entry rejects missing/mismatched source commit/tag;
- configuration/secrets/workflow permission changes cannot be compatible;
- release workflow emits exact source metadata without secret values.

Green files:

- `scripts/release/update-manifest.ts` and tests;
- `packages/update-engine/src/types.ts` and manifest tests;
- `.github/workflows/release.yml` and workflow contract test;
- reviewed `customer-release.json`.

Gate: scripts/update-engine tests, release workflow contract, typecheck.

### Slice B: `feature/client-update-pr`

Red tests:

- wrong seller URL/tag/SHA rejected;
- downgrade/non-descendant rejected;
- current version is a no-op;
- exact tag merges with ancestry preserved;
- rerun reuses existing PR/branch.

Green files:

- one small TypeScript planner/validator under `scripts/customer-update/`;
- customer update workflow under `.github/workflows/`;
- synthetic Git integration tests using temporary local bare repositories.

Gate: script tests and workflow contract tests. No network or real customer.

### Slice C: `feature/client-update-policy`

Red tests cover every auto/manual row in section 4.3 and failed required
checks. Green change enables auto-merge only for compatible metadata. Gate is
the synthetic customer PR state machine plus script tests.

### Slice D: `feature/customer-deployment-hardening`

Red tests cover parsed workflow permissions/DAG/concurrency, build-before-
migration ordering, seller-only official-upstream ingestion, exact source SHA,
manual migration gate, checksum mismatch, missing-ledger fail-closed behavior,
ambiguous retry reconciliation, Worker-before-Admin ordering, release evidence,
and rollback eligibility. Green changes introduce one release orchestrator,
make the old deploy workflows reusable/non-mutating on their own, harden the
migration runner, pin actions, and extend existing `update_history`.

### Slice E: `feature/client-onboarding`

Red tests cover clean-tag requirement, remote rewrite, no secret persistence,
idempotent rerun, and refusal to overwrite unrelated remotes/dirty work.
Green change adds the smallest checkout/GitHub commands under
`scripts/customer-onboarding/` and reuses existing `create-line-harness
--repo-dir --from-source` instead of adding a second installer.

### Slice F: `feature/prescription-foundation`

Red tests:

- migration constraints and bootstrap equivalence;
- complete state transition matrix;
- tenant/friend-scoped idempotency;
- CAS stale writes;
- image header/type/size validation;
- private image authorization.

Green change adds migration, feature-local domain/repository/routes, exact auth
exceptions, and marked Worker seam. No UI yet.

### Slice G: `feature/prescription-liff-upload`

Red tests cover auth failure, account mismatch, 0/5 images, noncontiguous
positions, duplicate replay, consent, upload failure, cancellation, mobile
labels, keyboard access, and double-submit. Green change adds the LIFF custom
page and minimal route seam.

### Slice H: `feature/prescription-admin-queue`

Red tests cover account filters, cross-account image denial, no-store headers,
stats, cursor ordering, action matrix, stale conflict, 404/503 UI, and accessible
viewer controls. Green change adds custom Admin page, thin route, and sidebar
entry/badge.

### Slice I: `feature/prescription-notifications-chat`

Red tests prove automatic/external attribution, manual chat remains manual,
correct account token, and notification failure isolation/retry. Green change
reuses the local LINE proxy and chat link.

### Slice J: `feature/prescription-history-resubmission`

Red tests prove no-thumbnail history, old revision remains active on partial
replacement, atomic activation of a complete replacement, and no access to
superseded revisions by another patient.

### Slice K: `feature/prescription-retention-cleanup`

Red tests cover exact due boundaries, bounded batches, retry after R2 failure,
idempotent rerun, active revision protection, and existing cron registration.

## 7. Verification matrix

Run affected tests during each slice. Before release, run:

```text
pnpm test:scripts
pnpm --filter @line-crm/db test
pnpm --filter @line-crm/db typecheck
pnpm --filter @line-harness/update-engine test
pnpm --filter create-line-harness test
pnpm --filter worker test
pnpm --filter worker typecheck
pnpm --filter liff test
pnpm --filter liff build
pnpm --filter web test
pnpm --filter web build
pnpm tsx scripts/check-migrations.ts
git diff --check
```

Then use disposable synthetic infrastructure to prove:

1. seller tag -> customer clone;
2. onboarding -> customer repository;
3. compatible seller release -> customer PR -> automatic merge;
4. manual release -> open unmerged PR;
5. customer main -> isolated Cloudflare deployment;
6. mobile development LINE submission -> admin action -> LINE notification;
7. replacement revision and retention cleanup with synthetic images only.

Never use production data, real prescriptions, real customer identities, or
production Cloudflare mutation as test evidence.

## 8. Completion audit ledger

All evidence below is local and synthetic. The latest matrix ran on 2026-08-17
JST. `none` means no unresolved implementation or test exception; it does not
authorize a push, merge, deployment, or use of real customer data.

| ID | Implementation commit | Direct passing evidence | Runtime evidence | Exception |
| --- | --- | --- | --- | --- |
| DIST-01 | `c549ebb` | `scripts/customer-onboarding/configure.test.ts`; `pnpm test:scripts` (99 tests) | Temporary private-style seller/customer Git repositories proved the immutable tag SHA. | none |
| DIST-02 | `c549ebb` | `configure.test.ts`, `github-settings.test.ts`; `pnpm test:scripts` | Temporary checkout proved customer `origin`, fetch-only `vendor`, clean rerun, and no tracked secrets. | none |
| DIST-03 | `c549ebb` | create-line-harness installer contract tests; `pnpm --filter create-line-harness test` (50 tests) | Synthetic onboarding used the existing source-checkout installer contract only. | none |
| UPD-01 | `a8e7aaf` | `customer-source-update.test.ts`, `customer-release-workflows.test.ts`; `pnpm test:scripts` | Immutable source SHA, sequence, policy, migration digests, and seller-only release dispatch were parsed from generated metadata. | none |
| UPD-02 | `bf93daf` | `prepare.test.ts`, `workflow.test.ts`; `pnpm test:scripts` | Temporary repositories proved exact-tag fetch, ancestry preservation, replay/downgrade rejection, and branch reuse. | none |
| UPD-03 | `782dc5e` | `policy.test.ts`, `workflow.test.ts`; `pnpm test:scripts` | Synthetic compatible update reached the merge-eligible state only after required checks. | none |
| UPD-04 | `782dc5e` | `policy.test.ts`; `pnpm test:scripts` | Synthetic breaking, configuration, permission, migration, conflict, and failed-check cases remained unmerged. | none |
| UPD-05 | `782dc5e`, `1b5ffa8` | parsed customer update/deployment workflow tests; `pnpm test:scripts` | Synthetic workflow contracts keep seller/update jobs outside customer Cloudflare and LINE environments. | none |
| DEP-01 | `782dc5e`, `1b5ffa8` | `workflow.test.ts`, `dev-deployment-workflows.test.ts`; `pnpm test:scripts` | Parsed PR jobs are read-only, secretless, environment-free, and non-deploying. | none |
| DEP-02 | `1b5ffa8` | `dev-deployment-workflows.test.ts`; `pnpm test:scripts` | Parsed DAG proves build-before-mutation, shared serialization, and Worker-before-Admin/LIFF ordering. | none |
| DEP-03 | `1b5ffa8` | `scripts/check-migrations.test.ts`, update-engine migration tests; `pnpm test:scripts`, `pnpm --filter @line-harness/update-engine test` (199 tests), `pnpm tsx scripts/check-migrations.ts` | Synthetic interrupted, replayed, concurrent, digest-mismatch, and ambiguous-result cases passed without real D1 mutation. | none |
| DEP-04 | `1b5ffa8` | `scripts/deploy/release-evidence.test.ts`; `pnpm test:scripts` | Synthetic persisted evidence included source/release SHAs, migration set, bookmark, deployment IDs, smoke result, and rollback eligibility. | none |
| RX-01 | `ee6f33d`, `e67e192`, `1a37634`, `adc4670` | Worker, LIFF, and Admin `boundary.test.ts`; package test commands below | Boundary enumeration accepts only feature-local files, marked seams, and `custom_001_pharmacy_prescriptions.sql`. | none |
| RX-02 | `ee6f33d`, `e67e192` | `routes.test.ts`, `patient.test.ts`, `image.test.ts`, `PrescriptionPage.test.tsx`; Worker (1043 tests), LIFF (10 tests) | Actual bootstrap SQLite E2E reserved a scoped draft and stored ordered synthetic images in an in-memory R2 adapter. | none |
| RX-03 | `ee6f33d`, `24dd7f7` | `repository.test.ts`, `routes.test.ts`, `custom_001_pharmacy_prescriptions.e2e.test.ts`; DB (146 tests), Worker (1043 tests) | Actual SQLite proved idempotent submission and tenant/friend/revision isolation. | none |
| RX-04 | `ee6f33d`, `e67e192` | `patient.test.ts`, `PrescriptionPage.test.tsx`; Worker and LIFF test commands | Mobile UI tests require both notices and accessible acknowledgement controls before submission. | none |
| RX-05 | `e67e192`, `24dd7f7` | `PrescriptionPage.test.tsx`, `repository.test.ts`, SQLite E2E; DB, Worker, and LIFF test commands | Actual SQLite kept revision 1 active after partial replacement and activated revision 2 only when complete; history contained no thumbnails. | none |
| RX-06 | `1a37634` | `PrescriptionQueuePage.test.tsx`, Admin `api.test.ts`; `pnpm --filter web test` (22 tests) | Exported Admin `/prescriptions.html` returned HTTP 200 under an iPhone User-Agent; production build completed. | none |
| RX-07 | `5d42f4e`, `24dd7f7` | `notifications.test.ts`, SQLite E2E; Worker and DB test commands | E2E emitted six automatic notifications with the correct account token and without the manual attribution header; manual chat behavior remains covered by the existing proxy tests. | none |
| RX-08 | `adc4670`, `24dd7f7` | `cleanup.test.ts`, SQLite E2E; Worker and DB test commands | Existing six-hour cron path deleted three due synthetic R2 objects while preserving active revisions and retry state. | none |
| RX-09 | `24dd7f7` | `custom_001_pharmacy_prescriptions.e2e.test.ts`, LIFF/Admin component tests; full matrix below | Actual SQLite plus synthetic R2/LINE covered submission, resubmission, admin completion, notification, and retention. Built LIFF `/prescriptions` and Admin `/prescriptions.html` each returned HTTP 200 under an iPhone User-Agent. | none |

Latest complete command matrix:

```text
pnpm test:scripts                                      # 99 passed
pnpm --filter @line-crm/db test                        # 146 passed
pnpm --filter @line-crm/db typecheck                   # passed
pnpm --filter @line-harness/update-engine test         # 199 passed
pnpm --filter create-line-harness test                 # 50 passed
pnpm --filter worker test                              # 1043 passed
pnpm --filter worker typecheck                         # passed
pnpm --filter liff test                                # 10 passed
pnpm --filter liff build                               # passed
pnpm --filter web test                                 # 22 passed
NEXT_PUBLIC_API_URL=https://worker.example pnpm --filter web build  # passed
pnpm tsx scripts/check-migrations.ts                   # 32 migrations passed
pnpm --dir packages/db generate:bootstrap --check      # passed
git diff --check                                       # passed
```

Every section 1 requirement now has direct implementation and test evidence,
and no implementation slice or ratification-dependent item remains open.

## 9. Plan review record

Initial review checks:

- scope preserves both customer distribution and the complete prescription MVP;
- existing release, installer, auth, state, R2, account context, and LINE proxy
  mechanisms are reused;
- public auth exceptions are exact and method-aware;
- source updates preserve Git ancestry and separate update credentials from
  deployment secrets;
- D1 changes are additive and rollback does not pretend to remove schema;
- patient images remain private and tenant-scoped;
- Worker/Admin deployment race has an explicit compatibility contract;
- cleanup is bounded and idempotent;
- every nontrivial behavior has a named runnable test;
- speculative GitHub App, OCR, payments, and generic abstractions are deferred.

First review corrections applied:

- added the automatic seller `main` to version tag/release dispatch path;
- bound verified LINE login channel to LIFF account and removed global friend
  fallback for prescription data;
- adopted the stated v1 retention policy so cleanup is not left indefinitely
  blocked while the Goal requires every planned item;
- isolated pull-request CI from all customer deployment secrets.

Oracle 0.18.0 was invoked with sanitized workflow attachments using verified
GPT-5.6 Sol and Pro thinking. The session initially stalled, completed after
reattachment, and returned `REQUEST_CHANGES`. The second review corrections
adopted here are:

- customer pull from an immutable seller release, never official OSS directly;
- exact previous/target ancestry and replay/downgrade/revocation checks;
- separate seller-read and customer-write identities, with no vendor App in
  customer repositories for the MVP;
- secretless read-only PR CI and permanent manual gates for privileged paths;
- all migrations require manual production approval;
- all artifacts build before the first migration;
- one serialized deployment orchestrator deploys Worker before LIFF/Admin;
- migration filename digests, missing-ledger fail-closed behavior, atomic
  migration/ledger recording, and ambiguous retry reconciliation;
- forward-schema rollback eligibility plus D1 bookmark and deployment IDs;
- narrow compatible auto-merge only after canary evidence and only for
  non-privileged, non-migration, non-dependency application changes.

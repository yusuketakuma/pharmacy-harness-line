# Security review evidence - 2026-08-19

This record describes local source and test evidence. It does not claim deployment, production configuration or production operation.

## E-1: frozen review snapshot

| Field | Value |
| --- | --- |
| Branch | `fix/dev-pharmacy-line-account-provisioning` |
| Reviewed head before this remediation batch | `6b17c758164ecdec77d7e1654a7235f3193c33dd` |
| Base branch snapshot (`main`) | `eedfd7ed3a147f425eb69b86b76cb1ab863efe35` |
| Merge base | `eedfd7ed3a147f425eb69b86b76cb1ab863efe35` |
| Upstream | `origin/dev` |
| Dirty state at freeze | dirty, 107 porcelain entries; review includes the shared worktree and does not attribute unrelated files to this batch |

Any later review must record a new snapshot; this row must not be reused as evidence for a different tree.

## E-2: route ownership matrix

| Surface | Method/path set | Principal | Tenant/account authority | Guards | Repository boundary |
| --- | --- | --- | --- | --- | --- |
| Patient prescription | `POST /api/liff/pharmacy/prescriptions`; `POST /:id/submit`; `PUT /:id/files/:position`; `GET /me`; `POST /:id/{cancel,resubmission,arrival}` | verified LINE ID token | token audience -> active account; token subject -> friend | LIFF auth + prescription capability | every query uses `line_account_id` and `friend_id` |
| Patient intake | `GET,POST /api/liff/pharmacy/patients`; `GET,PATCH /:id`; `GET,POST /:id/intake`; `POST /:id/archive` | verified LINE ID token | token audience and owner friend | LIFF auth + intake capability | composite account/owner/patient keys |
| Patient Myna | `POST /api/liff/pharmacy/myna-handoffs`; `GET /active`; `POST /:id/{launch,patient-report}` | verified LINE ID token | token audience and owner friend | LIFF auth + Myna capability | account/friend/patient predicates |
| Patient continuity/follow-up | `GET /api/liff/pharmacy/continuity`; `POST /expectations/:id/respond`; `POST /:id/pause`; `GET /api/liff/pharmacy/medication-followups`; `POST /:id/respond` | verified LINE ID token | token audience and owner friend | LIFF auth + domain capability | account/friend scope and CAS transitions |
| Staff prescription | `GET /api/custom/pharmacy/prescriptions{,/stats,/:id,/:id/files/:fileId}`; `POST /:id/actions/:action`; `GET,POST /fulfillment-quotes/:submissionId` | tenant staff session/API token | signed-in tenant membership + active account assignment | tenant selector + pharmacy account guard | account-scoped list/detail/file/action/quote functions |
| Staff intake/Myna/follow-up | `/api/custom/pharmacy/patients*`, `/myna-*`, `/medication-followups*`, `/continuity*` | tenant staff session/API token | membership + active account assignment | pharmacy account and domain capability guards | account-scoped repositories; server-owned IDs are selectors only |
| Staff operational UI | `/api/custom/pharmacy/{print,activity-notifications,growth,rich-menus}*` | tenant staff session/API token | membership + active account assignment | pharmacy account guard | account keys and compound parent checks |
| Platform admin | `/api/platform-admin/*` | separate platform-admin session | explicit support grant for tenant PHI reads | platform-admin auth, step-up/grant, audit-before-response, no-store | tenant/grant predicates in platform-admin repositories |
| Generic tags/Webhook CRUD | `/api/tags*`, `/api/webhooks/{incoming,outgoing}*` | tenant staff session/API token | authenticated `tenantId`, never a query parameter | main auth + pharmacy allowlist; pharmacy tags are read-only | `custom_034`, repository `tenant_id IS ?` predicates |
| Public incoming Webhook delivery | `POST /api/webhooks/incoming/:id/receive` | HMAC signature | webhook ID selects key; HMAC is authority | minimum secret, constant-time signature verification | unscoped ID lookup is deliberately limited to this public delivery path |

The complete handler declarations remain mechanically discoverable with `rg "\\.(get|post|put|patch|delete)\\('/api/" apps/worker/src`; this matrix groups declarations that share exactly the same principal, guard and repository boundary.

## E-3: tenant-owned storage matrix

The canonical detailed matrix is `MULTITENANT_OWNERSHIP_MATRIX.md`. Additions in this batch:

| Table | Tenant column | Parent/FK | Uniqueness/NULL | External reference |
| --- | --- | --- | --- | --- |
| `tags` | `tenant_id` | FK `tenants(id)` | nullable only for unattributable legacy rows; tenant reads exclude them; legacy `name UNIQUE` remains a known availability constraint | none |
| `incoming_webhooks` | `tenant_id` | FK `tenants(id)` | nullable only for unattributable legacy rows; CRUD excludes them | secret is stored in D1; never returned after create |
| `outgoing_webhooks` | `tenant_id` | FK `tenants(id)` | nullable only for unattributable legacy rows; CRUD excludes them | HTTPS URL and secret |
| Pharmacy patient/intake | `line_account_id` plus owner/patient compound keys | `custom_002`, `custom_022` | non-null account and compound unique/FK rules | no R2 object in answers |
| Prescription files | parent submission supplies account | submission/file FK and account-checked lookup | file ID plus active revision/state | private R2 key, never authority |

## E-4: background-path audit

| Path | Scope/idempotency evidence | Failure handling |
| --- | --- | --- |
| LINE webhook inbox | account-scoped durable receipt and dedupe key | lease/retry/dead-letter; receipt write fails before 200 |
| Cron inbox sweep | same `runWebhookInboxEvent` as live delivery | bounded retries and dead-letter |
| Notifications/follow-up | account-scoped event and idempotency keys | retry-pending state; PHI-free templates |
| Continuity/Myna transitions | account predicates and CAS | state/event writes batched; losing CAS writes no event |
| Broadcast/scenario/generic delivery | pharmacy generic-feature guard | unavailable to pharmacy tenants unless explicitly scoped and allowed |
| Booking/webinar/event paths | pharmacy generic-feature guard | unavailable to pharmacy tenants |

## E-5: negative-test matrix

| Credential A | Resource B | Expected | Test evidence |
| --- | --- | --- | --- |
| Tenant A staff | Tenant B account/friend/patient/prescription/Myna/continuity | 403 or non-enumerating 404 | `tenant-boundary.test.ts`, pharmacy repository/route tenant tests |
| Patient A token | Patient B patient/intake/prescription/follow-up | 404 | LIFF route ownership tests under each custom domain |
| Wrong LIFF audience | any pharmacy LIFF resource | 401/403 | `liff-auth.test.ts`, `liff-profile-tenant.test.ts` |
| Tenant A staff | Tenant B tag/incoming/outgoing Webhook | empty/404/no mutation | `custom_034_generic_resource_tenant_scope.test.ts` |
| No support grant | platform-admin PHI read | denied without PHI | platform-admin route tests |
| Invalid incoming HMAC | incoming Webhook receive | 401, no event | `webhooks.test.ts` |

## E-6: R2 lifecycle and environment evidence

Local `apps/worker/wrangler.toml` binds default/dev to `line-harness-images-dev` and production to `line-harness-images`; they are distinct names. On 2026-08-19, read-only lifecycle queries for both names returned Cloudflare error 7003 because the checked-in account identifier is the placeholder `YOUR_DEV_ACCOUNT_ID`. Therefore lifecycle rules and live dev/prod account separation are `NOT_RUN`, not inferred. The prefix retention decision remains blocked on the H-5 legal/operations decision.

Provisional retention classes, pending that decision:

| Prefix/data | Class | Automatic deletion |
| --- | --- | --- |
| `custom/pharmacy/prescriptions/` | clinical workflow record candidate | none until legal retention is approved |
| rich-menu assets | regenerable configuration asset | replace/delete with owning configuration |
| webhook durable payloads in D1 | operational retry record | completed/dead-letter rows after 30 days; pending/processing retained |
| audit events | security/legal evidence | no deletion rule until legal hold and retention are approved |

## E-7: bounded conclusion

In the four tested pharmacy LIFF families, no route reproduced a read or write of another tenant's or another patient's PHI. This is not a repository-wide proof: generic CRUD, broadcasts and background delivery remain outside that statement unless named above, and production configuration remains unverified.

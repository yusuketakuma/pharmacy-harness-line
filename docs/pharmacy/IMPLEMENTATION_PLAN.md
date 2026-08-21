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

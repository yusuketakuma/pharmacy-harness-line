# Pharmacy logical-tenant ownership matrix

Status: local source/test evidence on `v0.26.0/feature/logical-multitenancy`.
This document does not claim that the public Cloudflare runtime has been
deployed.

## Authority

| Request surface | Tenant authority | Account selector rule | Denial evidence |
| --- | --- | --- | --- |
| Admin browser | server-side tenant session + active membership | `accountId` is checked against membership and `pharmacy_staff_accounts` | `tenant-boundary.test.ts`, `staff-tenant-scope.test.ts` |
| SDK/MCP bearer | API token + required `X-Tenant-Id` membership | query/body/path account IDs are selectors only | `auth.test.ts`, `line-accounts.test.ts` |
| Pharmacy LIFF | verified LINE ID token audience (`liffId`) | token audience resolves to exactly one active mapped account | `liff-auth.test.ts`, `liff-profile-tenant.test.ts` |
| LINE webhook | destination channel + encrypted account credential | receipt, friend, and event writes use the resolved account | `webhook.test.ts`, `custom_021_pharmacy_webhook_event_receipts.test.ts` |
| R2 image read | authenticated staff + linked page/submission row | object key is never authorization evidence | `images.test.ts`, `rich-menu-groups.test.ts` |

## Pharmacy-owned data

| Domain | Scope proof | Storage boundary |
| --- | --- | --- |
| LINE account and staff | tenant mapping + active membership + account assignment | `tenant_line_accounts`, `tenant_staff_memberships`, `pharmacy_staff_accounts` |
| Friend/contact | `friends.line_account_id` and provider identity | unique account/provider identity indexes from `custom_016` |
| Patient, family, intake | direct account key plus owner-friend/patient relationships | `custom_001`/`custom_002` tables and `custom_022` triggers |
| Prescription, files, validity, quote | submission account key and parent relationship | pharmacy submission tables; account-prefixed R2 keys |
| Continuity, Myna, follow-up, activity | direct account key and parent scope | pharmacy custom tables; `custom_022` cross-parent triggers |
| Rich menu | account-owned group/page and linked image | D1 group rows + account-prefixed R2 keys + encrypted LINE token lookup |
| LINE credentials | tenant/account/kind + encrypted envelope | `pharmacy_line_credentials`; legacy columns are sentinels after migration |

## Public and generic surfaces

The pharmacy product is fail-closed. The following generic surfaces are not
tenantized in the legacy schema and therefore remain unavailable to pharmacy
tenants; they must not be described as safe shared CRM features:

- broadcasts, scenarios, automations, reminders, mileage, scoring;
- affiliates, conversions, traffic pools, webinars, forms, events, booking;
- generic tags, operators, generic rich menus, and global link settings;
- legacy OAuth/LIFF routes and generic OGP event/form previews.

The API allowlist and generic-feature guard reject these routes before the
handler can read or mutate a legacy row. `notFoundHandler` also suppresses
generic form/event preview queries for a pharmacy deployment.

## Migration and runtime gates

- `custom_014` through `custom_022` are additive; applied files are immutable.
- Fresh bootstrap is generated from the complete migration set and checked by
  `generate:bootstrap --check`.
- Preflight rejects duplicate login channel IDs, LIFF IDs, account/provider
  identities, and unowned provider identities before a D1 migration apply.
- Repeated migration application is accepted by the migration ledger; raw
  replay of an `ALTER TABLE` migration is not a supported deployment action.
- Worker, LIFF, and Admin builds must carry the same origin/API contract and a
  pharmacy LIFF build marker. A public HTTP 200 shell is not deployment proof.

## Explicit residuals

The following are intentionally not represented as completed:

- physical tenant columns for dormant generic CRM tables;
- live Cloudflare D1/R2/Secrets verification or migration application;
- live LIFF Pages asset freshness and actual LINE rich-menu publication;
- external LINE default-menu/bulk-link success after a remote partial failure.

Those items require a separate human gate or a bounded follow-up migration;
they are not silently inferred from local tests.

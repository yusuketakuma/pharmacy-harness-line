# Pharmacy beta participation boundary

Status: local source/test evidence on `dev` (v0.35.0 dev release line).
This document is the canonical operation matrix for V035-5. It does not claim
that a beta account has been activated, that production migrations have run,
or that any LINE mutation or deployment has occurred. `beta_enabled` defaults
to `0` and remains off everywhere.

## Authority layers (distinct, not interchangeable)

| Layer | Evidence it provides | What it does not prove |
| --- | --- | --- |
| LINE identity | verified ID token audience (`liffId`) resolves to exactly one account + friend | beta participation, consent, proxy permission |
| Patient/proxy authority | `patientAuthorityPredicate`: owner friend, patient link, archive state, binding suspension, minor proxy expiry | beta membership |
| Consent/privacy state | representative + privacy consent versions, control version CAS | beta membership |
| Account capability | `pharmacy_account_capabilities` feature flag (e.g. `prescription_intake`) | beta membership |
| Beta membership | `pharmacy_beta_memberships` row, `active` in server time `[starts_at, expires_at)`, account × participant × subject, CAS version | any of the above |

All five are evaluated server-side. Query or body fields such as
`line_account_id`, `friendId`, `patientId` are selectors, never authority.

## Operation matrix

"Membership required" means `canUsePharmacyBetaParticipant(DB,
patient.lineAccountId, patient.friendId)` is checked after identity and
patient resolution and before the handler. Denial is always
`403 {"error":"Pharmacy beta participation required"}`; the handler never
runs and no record, notification, or side effect is produced.

| Operation | Route surface | Pre-beta authority | Membership | Deny / continue | Test evidence |
| --- | --- | --- | --- | --- | --- |
| Patient list read | `GET /api/liff/pharmacy/patients` | LINE identity + owner | required | 403; nothing read | `intake/routes.test.ts` — "rejects a non-participant before reading the patient list" |
| New patient / intake registration | `POST /api/liff/pharmacy/patients`, `POST .../intake` | identity + proxy terms consent + capability | required | 403; no record created | `intake/routes.test.ts`; DB membership gates in `custom_072_pharmacy_beta_memberships.test.ts` |
| Patient update | `PATCH /api/liff/pharmacy/patients/:id` | identity + owner + CAS | required | 403 | `intake/routes.test.ts` |
| Prescription history read | `GET /api/liff/pharmacy/prescriptions/me` | identity + owner | required | 403; stored records untouched | `prescriptions/routes.test.ts` — "rejects a non-participant with the resolved account and friend, not query input" |
| Prescription submit / resubmit / cancel / file ops | `POST/DELETE /api/liff/pharmacy/prescriptions/*` | identity + owner + patient authority + CAS + capability | required | 403; staged R2 bytes follow existing reconciliation | `prescriptions/routes.test.ts` |
| Myna handoff create / active / launch / patient-report | `/api/liff/pharmacy/myna-handoffs*` | identity + owner + capability | required | 403; existing handoff row preserved | `myna/routes.test.ts` — "rejects a non-participant before reading the active handoff" |
| Continuity view / pause / expectation response | `/api/liff/pharmacy/continuity*` | identity + owner | required | 403; obligation rows unchanged | `continuity/routes.test.ts` — "rejects a non-participant before reading the patient continuity view" |
| Patient timeline | `GET /api/liff/pharmacy/timeline` | identity + owner | required | 403 | `patient-timeline/routes.test.ts` — "rejects a non-participant before reading the timeline" |
| Medication follow-up list / detail / respond | `/api/liff/pharmacy/medication-followups*` | identity + owner + CAS + idempotency | required | 403; no event written | `medication-followup/routes.test.ts` — "rejects a non-participant before listing follow-ups"; `respond-pagination.test.ts` |
| Withdrawal control paths | `.../patients/:id/{proxy-grant,privacy-consent,notification-preference,archive}` | identity + owner + control version CAS | **not required (explicit exemption)** | always available — withdrawal/stop must not be gated | `intake/routes.ts:105-108`; `intake/routes.test.ts` — "keeps withdrawal control paths available to a non-participant" |
| Data-subject requests | `/api/liff/pharmacy/data-subject-requests*` | existing identity/authorization | not required | always available | `data-subject-requests/routes.test.ts`, `boundary.test.ts` |
| Public pharmacy profile / privacy policy | public + LIFF profile routes | none/public | not required | always available | `public-profile/routes.test.ts`, `privacy-policy/routes.test.ts` |
| Emergency contraception intake | `/api/liff/pharmacy/emergency-contraception*` | identity + owner + PHI key present + EC availability model | not required (EC keeps its own regulated availability gate; see Residuals) | EC-specific denials only | `emergency-contraception/routes.test.ts` |
| Inbound LINE message / postback / follow / unfollow | LINE webhook | channel + account credential | not required | received into manual chat; **never enrolls sender in beta clinical work** | `webhook-pharmacy-mode.test.ts` |
| Queued notification dispatch | outbox senders | binding row created at queue time | **re-verified at dispatch** against membership generation | `active`→send; `suspended`→retryable (not failed); `revoked`+regrant→old queue never resurrected; `operations_blocked`→fail-closed | `custom_077_pharmacy_beta_notification_bindings.test.ts`; `growth-loop/sender.test.ts`; `medication-followup/notifications.test.ts` |
| Staff terminal reads/mutations | `/api/custom/pharmacy/*` | staff session + account assignment | not required (staff authority, not participant authority) | staff 401/403 via admin gate | per-domain admin tests (e.g. `continuity/routes.test.ts` "rejects staff obligations outside the assigned account") |
| Membership grant / suspend / resume / revoke | beta-membership admin routes | staff session + account assignment + CAS + audit | n/a | audit INSERT failure rolls back membership change | `beta-membership/routes.test.ts`; `custom_072_pharmacy_beta_memberships.test.ts` |
| Adult family proxy participation | membership grant | — | always denied | stays closed until formal proxy procedure is fixed | `custom_072_pharmacy_beta_memberships.test.ts` — adult family rejection |

## Boundary scenarios ↔ tests (V035-5 DoD)

| Scenario | Expected behavior | Test evidence |
| --- | --- | --- |
| Forwarded LIFF URL carrying foreign ids | `liffId` + verified token resolve the account/friend; `line_account_id`/`friendId`/`patientId` parameters are never authority | `prescriptions/routes.test.ts` non-participant test asserts the check ran with the resolved `account-1`/`friend-1`, not query input; `patient-timeline/routes.test.ts` identity scope test |
| Valid token, unregistered participant | every gated domain returns 403 before any read/write | the six new non-participant tests above; `custom_072` `canUsePharmacyBetaParticipant` false cases |
| Different tenant / account / patient | identity→account binding is single-valued; cross-account writes rejected at FK + scope | `custom_072` cross-account rejection; per-domain cross-account denial tests; `MULTITENANT_OWNERSHIP_MATRIX.md` |
| Expired proxy | minor proxy expiry/ revocation participates in `patientAuthorityPredicate`; membership grant for proxies requires current proxy consent | `custom_072` expiry boundary `[starts_at, expires_at)`; `intake/routes.test.ts` proxy-consent cases |
| Session/job after revocation | membership re-checked inside write transaction and at dispatch; queued work keeps its authorizing membership generation | `custom_077` binding tests; `growth-loop/sender.test.ts` dispatch-time recheck, suspended-retryable, regrant non-resurrection |
| Replayed webhook | provider event id dedup via `pharmacy_webhook_event_receipts`; replay produces no duplicate side effect | `custom_021_pharmacy_webhook_event_receipts.test.ts`; `webhook-durable-inbox.test.ts` |

## Non-participant LINE chat separation

- Inbound text is stored for the manual chat surface (`upsertChatOnMessage`)
  and remains an ordinary consultation. Receiving a message does not create
  or reactivate a membership, patient link, submission, obligation, or
  follow-up.
- Generic automation, mileage, auto-reply and scenario enrollment are
  fail-closed in pharmacy mode (`webhook-pharmacy-mode.test.ts`).
- Handling, retention, guidance and responsible staff for ordinary
  consultations follow `RETENTION_MATRIX.md` and the manual-chat procedure
  (`X-Line-Harness-Source: manual` on 1:1 staff replies).

## Owner-assigned applicability decisions

| Decision | Owner | Current state |
| --- | --- | --- |
| Retention/deletion periods for memberships, clinical records, staged bytes | product/pharmacy/legal owner | not fixed — `RETENTION_MATRIX.md`; no production delete implied |
| Whether a specific in-flight clinical case may continue after suspension | pharmacy owner, per case | code preserves records and denies new work; no auto-continue |
| Staff terminal drain applicability after revocation | pharmacy owner + security/infra owner | staff reads stay under staff authority; drain procedure not fixed |
| Adult family formal proxy participation | product/pharmacy/legal owner | denied; requires verified identity, proxy evidence trail, allowed-operation list, expiry/revocation operation |
| Business hours / response SLA / primary & backup staff | pharmacy owner (V035-6) | unfixed — follow-up sender stays `operations_blocked` |
| MFA | — | not introduced for LINE-ID-token patient auth or staff sessions; must not be changed without owner approval and a ledger entry |

## Rollback / forward-fix boundary

- An activated beta cannot safely roll back by switching `beta_enabled` off:
  an old Worker does not know the admission rule and would reopen gated
  writes. Prove a compatible hard-stop path covering old create/resubmit/
  jobs, or keep the new Worker and forward-fix.
- Missing admission schema must not silently reopen an enabled beta: absent
  `pharmacy_beta_memberships`/`beta_notification_bindings` fails the query
  (error), it does not pass it.
- Regrant after revoke creates a new membership row; bindings from the
  revoked generation stay bound to the old `membership_id` and are not sent.

## Explicit residuals

- EC intake is intentionally outside the beta gate in the current code and
  keeps its own availability model; whether the beta cohort boundary should
  also cover EC is an owner decision, recorded here rather than inferred.
- One-pharmacy cohort size ("five-person") is a proposal, not an enforced
  limit; no member-count cap exists in code.
- All human gates (staff trial, real device, real LINE lifecycle, production
  migration/deploy, beta activation) remain `NOT_RUN` in
  `docs/pharmacy/evidence/v0.35.0-beta-scope-and-staff-critical-journey.json`.

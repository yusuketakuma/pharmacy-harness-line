# Pharmacy activity notifications

This module is an account-scoped activity inbox for pharmacy staff. It is an
internal queue only: it does not send LINE messages and does not copy patient,
prescription, drug, or LINE identity data.

## Data contract

`pharmacy_activity_notifications` stores one row per `(line_account_id,
staff_id, idempotency_key)`. The only event context is `activity_type`; there
is no free-form payload column. Supported activity types are:

- `prescription_received`
- `prescription_status_changed`
- `fulfillment_quote_created`
- `myna_handoff_received`
- `patient_message_received`
- `continuity_due`
- `manual_activity`

Notification state is `unread -> claimed -> acknowledged`. A claim or
acknowledgement is an account- and recipient-scoped compare-and-set operation.
Retries by the same recipient are idempotent; a different state or recipient
returns a conflict/not-found result.

`pharmacy_activity_notification_events` is the audit trail for `created`,
`claimed`, and `acknowledged`. Notification and audit writes use one D1 batch.
The migration also uses a composite `(staff_id, line_account_id)` foreign key,
and the service requires the staff row to be active and not deleted.

## Service API

Event writers call the service directly; there is intentionally no arbitrary
HTTP enqueue endpoint.

```ts
enqueueActivityNotifications(db, {
  lineAccountId,
  activityType,
  staffIds,
  idempotencyKey,
})

enqueueActivityForAccount(db, lineAccountId, activityType, idempotencyKey)
listActivityNotifications(db, lineAccountId, staffId, { status, limit })
claimActivityNotification(db, lineAccountId, notificationId, staffId)
acknowledgeActivityNotification(db, lineAccountId, notificationId, staffId)
listActivityNotificationEvents(db, lineAccountId, notificationId, staffId)
```

`idempotencyKey` is an opaque ASCII token (`A-Z`, `a-z`, `0-9`, `.`, `_`,
`:`, `-`, max 160 characters). Callers must not put a patient name, LINE user
ID, prescription text, drug name, or other PHI in it.

## HTTP API

The root Worker mounts `activityNotificationRoutes` after staff auth:

- `GET /api/custom/pharmacy/activity-notifications?line_account_id=...`
- `POST /api/custom/pharmacy/activity-notifications/:id/claim?line_account_id=...`
- `POST /api/custom/pharmacy/activity-notifications/:id/ack?line_account_id=...`
- `GET /api/custom/pharmacy/activity-notifications/:id/events?line_account_id=...`

The query account is only a scope selector. Each request uses the authenticated
`staff.id` and verifies its active membership in that exact `line_account_id`
before reading or mutating anything.

## Caller integration

Root caller integration should enqueue after the source operation has committed,
using only the event type and a stable non-sensitive idempotency key. The
initial writer candidates are prescription receipt/status, fulfillment quote
creation, and Myna verification. Patient-facing automatic push remains out of
scope.

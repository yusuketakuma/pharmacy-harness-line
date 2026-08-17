# Pharmacy print and activity notifications

## Scope

This feature branch adds two account-scoped operational aids:

1. A print queue for ready prescription images.
2. A staff activity inbox for pharmacy events.

Both features are under `custom/pharmacy`. They do not send patient messages,
store prescription content in an analytics table, or copy R2 keys into the
activity inbox.

## Print flow

```text
LINE/LIFF upload
      |
      v
prescription files in R2 + D1 received state
      |
      v
D1 pharmacy_print_jobs (one job per active-revision file)
      |
      v
Admin web print view -> browser print dialog -> pharmacy printer
```

The Worker cannot safely or portably access a local USB/network printer. The
admin web page therefore fetches the existing account-scoped image endpoint,
renders the active revision, and calls `window.print()` only after a staff
click. The page offers a separate “印刷済みを記録” action. A future resident
agent may claim the same queue, but it is not required for Release 1.

Print jobs are idempotent by account, submission, file, and revision. When a
replacement image revision is received, queued jobs for older revisions are
cancelled before the new files are queued. Claim, printed, failed, and
cancelled transitions append immutable print events. Failure codes are fixed
values; free-form notes are not accepted.

## Activity notification flow

```text
prescription / quote / Myna event
      |
      v
D1 pharmacy_activity_notifications (one row per assigned staff)
      |
      v
Admin web “薬局の動き” -> claim -> acknowledge
```

Activity rows contain only an approved event kind, an opaque idempotency key,
status, timestamps, and account/staff ownership. They do not contain patient
names, LINE user IDs, prescription text, drug names, or free-form notes.

The initial event writers are prescription receipt/status, fulfillment quote
creation, and Myna verification. Notification delivery to patients is outside
this feature; this is an internal staff inbox.

## Migrations

- `custom_009_pharmacy_print_queue.sql`
- `custom_010_pharmacy_activity_notifications.sql`

Both migrations are additive. Applied migrations must not be edited. Run the
bootstrap generator after reviewing the migrations.

## Human gates

- Confirm the Japanese labels and staff workflow with the pharmacy.
- Test the browser print dialog and target printer on the pharmacy PC.
- Decide whether the print button requires a second-person check.
- Define the retention period for print audit rows before production rollout.
- Do not enable unattended local-agent printing without a separate secret,
  installation, printer-permission, and retry review.

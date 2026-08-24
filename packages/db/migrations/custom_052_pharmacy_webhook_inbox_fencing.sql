-- V033-5: fence webhook inbox settlement to the worker that owns the current lease.
-- Nullable keeps already-stored pending/processing receipts forward-compatible.

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN claim_token TEXT;

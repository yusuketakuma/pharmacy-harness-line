-- Audit staff reads of prescription images, alongside the existing mutation
-- events (status changes, file deletion) already recorded in
-- pharmacy_prescription_events. Without this, a suspected unauthorized-
-- browsing investigation can only show which patients an account could
-- reach, not which ones it actually viewed.
--
-- This is a SEPARATE, purely additive table rather than widening
-- pharmacy_prescription_events.event_type's CHECK constraint. SQLite cannot
-- ALTER an inline CHECK; the only way to change one is to recreate the
-- table (CREATE ... new, copy rows, DROP old, RENAME new). The update
-- engine's safe-D1-update path (packages/update-engine/src/migrations.ts,
-- splitSqlStatements) unconditionally rejects DROP TABLE/COLUMN and RENAME
-- as destructive, since a duplicate/partial ALTER on an existing customer
-- install can silently roll back later statements in the same file. A view
-- event also has a different shape from a mutation event (no from_status/
-- to_status/reason_code/revision), so a dedicated table is a better fit
-- anyway.

CREATE TABLE IF NOT EXISTS pharmacy_prescription_view_events (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES pharmacy_prescription_files(id) ON DELETE CASCADE,
  staff_id      TEXT NOT NULL,
  viewed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_prescription_view_events_submission
  ON pharmacy_prescription_view_events (submission_id, viewed_at);

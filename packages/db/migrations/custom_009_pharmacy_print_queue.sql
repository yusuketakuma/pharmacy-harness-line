-- Account-scoped prescription print jobs. The Worker owns the queue; it never
-- connects to a local printer. R2 keys remain in pharmacy_prescription_files.

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_prescription_files_id_submission
  ON pharmacy_prescription_files (id, submission_id);

CREATE TABLE pharmacy_print_jobs (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  submission_id      TEXT NOT NULL,
  file_id            TEXT NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  idempotency_key    TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  status             TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','printed','failed','dead_letter','cancelled')),
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at       TEXT NOT NULL,
  claimed_by         TEXT,
  claimed_at         TEXT,
  lease_until        TEXT,
  printed_at         TEXT,
  last_failure_code  TEXT CHECK (last_failure_code IS NULL OR last_failure_code IN
    ('printer_unavailable','paper_empty','ink_or_toner','invalid_document','unknown')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  UNIQUE (line_account_id, submission_id, file_id, revision),
  UNIQUE (id, line_account_id),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id),
  FOREIGN KEY (file_id, submission_id)
    REFERENCES pharmacy_prescription_files(id, submission_id)
);

CREATE INDEX idx_pharmacy_print_jobs_due
  ON pharmacy_print_jobs (line_account_id, status, available_at, id);
CREATE INDEX idx_pharmacy_print_jobs_history
  ON pharmacy_print_jobs (line_account_id, created_at DESC, id DESC);

CREATE TABLE pharmacy_print_events (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  event_type         TEXT NOT NULL CHECK (event_type IN
    ('enqueued','claimed','lease_expired','printed','failed','retry_scheduled',
     'manual_retry','cancelled','downloaded')),
  actor_type         TEXT NOT NULL CHECK (actor_type IN ('system','staff','agent')),
  actor_id           TEXT,
  attempt_count      INTEGER NOT NULL CHECK (attempt_count >= 0),
  failure_code       TEXT CHECK (failure_code IS NULL OR failure_code IN
    ('printer_unavailable','paper_empty','ink_or_toner','invalid_document','unknown')),
  available_at       TEXT,
  created_at         TEXT NOT NULL,
  FOREIGN KEY (job_id, line_account_id)
    REFERENCES pharmacy_print_jobs(id, line_account_id)
);

CREATE INDEX idx_pharmacy_print_events_job
  ON pharmacy_print_events (line_account_id, job_id, created_at, id);

-- Append-only is enforced by the Worker repository: no update/delete path is
-- exposed for events. The bootstrap generator intentionally supports only
-- semicolon-delimited statements, so trigger-based enforcement is omitted.

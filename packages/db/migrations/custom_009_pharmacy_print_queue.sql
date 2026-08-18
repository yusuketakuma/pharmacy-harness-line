-- Web-admin print coordination. One task represents one active prescription revision.
-- The browser owns physical printing; no printer agent or printer telemetry is stored.

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_prescription_submissions_id_account
  ON pharmacy_prescription_submissions (id, line_account_id);

CREATE TABLE IF NOT EXISTS pharmacy_print_tasks (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  submission_id      TEXT NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'handling', 'acknowledged', 'cancelled')),
  handling_by        TEXT,
  handling_token     TEXT CHECK (handling_token IS NULL OR length(handling_token) BETWEEN 8 AND 160),
  handling_at        TEXT,
  lease_until        TEXT,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (
    status IN ('pending', 'cancelled')
    OR (status = 'handling' AND handling_by IS NOT NULL AND handling_token IS NOT NULL
        AND handling_at IS NOT NULL AND lease_until IS NOT NULL)
    OR (status = 'acknowledged' AND handling_by IS NOT NULL AND handling_token IS NOT NULL
        AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, submission_id, revision),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_print_tasks_open
  ON pharmacy_print_tasks (line_account_id, status, created_at, id);

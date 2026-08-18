-- Explicit staff-to-LINE-account assignments for pharmacy operations.
-- System owners are authorized by the Worker channel binding; admin/staff
-- principals must have an active row here before accessing a pharmacy account.

CREATE TABLE IF NOT EXISTS pharmacy_staff_accounts (
  line_account_id TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, staff_id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_staff_accounts_staff
  ON pharmacy_staff_accounts (staff_id, is_active, line_account_id);

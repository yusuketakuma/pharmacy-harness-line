-- Audited, short-lived tenant-owner sessions issued only through the platform CLI key.

CREATE TABLE IF NOT EXISTS pharmacy_cli_break_glass_sessions (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE
                    REFERENCES tenant_admin_sessions(token_hash) ON DELETE RESTRICT,
  platform_admin_id TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id         TEXT NOT NULL,
  staff_id          TEXT NOT NULL,
  operation_scope   TEXT NOT NULL CHECK (operation_scope = 'all'),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  ticket_reference  TEXT CHECK (
                    ticket_reference IS NULL OR length(ticket_reference) BETWEEN 1 AND 120),
  issued_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revoked_by        TEXT REFERENCES platform_admins(staff_id),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships(tenant_id, staff_id),
  CHECK (
    unixepoch(issued_at) IS NOT NULL AND unixepoch(expires_at) IS NOT NULL AND
    unixepoch(expires_at) - unixepoch(issued_at) BETWEEN 1 AND 7200
  ),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_cli_break_glass_active
  ON pharmacy_cli_break_glass_sessions (tenant_id, revoked_at, expires_at);

CREATE TRIGGER IF NOT EXISTS pharmacy_cli_break_glass_update
BEFORE UPDATE ON pharmacy_cli_break_glass_sessions
WHEN OLD.revoked_at IS NOT NULL OR
     NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR
     NEW.id IS NOT OLD.id OR
     NEW.token_hash IS NOT OLD.token_hash OR
     NEW.platform_admin_id IS NOT OLD.platform_admin_id OR
     NEW.tenant_id IS NOT OLD.tenant_id OR
     NEW.staff_id IS NOT OLD.staff_id OR
     NEW.operation_scope IS NOT OLD.operation_scope OR
     NEW.reason IS NOT OLD.reason OR
     NEW.ticket_reference IS NOT OLD.ticket_reference OR
     NEW.issued_at IS NOT OLD.issued_at OR
     NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CLI_BREAK_GLASS_SESSION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_cli_break_glass_delete
BEFORE DELETE ON pharmacy_cli_break_glass_sessions
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CLI_BREAK_GLASS_SESSION_IMMUTABLE'); END;

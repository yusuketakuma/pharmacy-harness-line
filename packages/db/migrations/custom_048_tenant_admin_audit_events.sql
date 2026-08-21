-- Tenant-side admin audit trail (same shape as platform_admin_access_events).
-- Rows carry kind/actor/resource ids only: never PHI, passwords, or credential values.
-- tenant_id covers tenant admin actions (staff, LINE account credentials);
-- line_account_id covers account-scoped PHI views (prescription detail, intake).

CREATE TABLE IF NOT EXISTS tenant_admin_audit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  line_account_id TEXT,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  detail_json     TEXT,
  created_at      TEXT NOT NULL,
  CHECK (tenant_id IS NOT NULL OR line_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tenant_admin_audit_events_tenant
  ON tenant_admin_audit_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenant_admin_audit_events_account
  ON tenant_admin_audit_events (line_account_id, created_at);

CREATE TRIGGER IF NOT EXISTS tenant_admin_audit_events_immutable_update
BEFORE UPDATE ON tenant_admin_audit_events
BEGIN SELECT RAISE(ABORT, 'TENANT_ADMIN_AUDIT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS tenant_admin_audit_events_immutable_delete
BEFORE DELETE ON tenant_admin_audit_events
BEGIN SELECT RAISE(ABORT, 'TENANT_ADMIN_AUDIT_EVENT_IMMUTABLE'); END;

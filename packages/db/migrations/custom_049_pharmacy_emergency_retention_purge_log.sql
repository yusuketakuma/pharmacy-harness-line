-- NEXT-2. Durable record of what the account's own retention_days purge deleted.
--
-- pharmacy_emergency_settings.retention_days (1-365, custom_035) is the
-- patient-facing promise shown at consent time (EmergencyContraceptionPage.tsx
-- "保存期間 N日間"), separate from and shorter than the uniform 3-year PHI
-- floor in RETENTION_MATRIX.md — see that file's "Deferred" §5, resolved
-- 2026-08-22: the account's own promise takes precedence for this table.
--
-- This is deliberately a new table rather than reusing
-- pharmacy_phi_retention_purge_log (custom_037): that table's resource_type
-- CHECK only allows 'prescription_file' and SQLite cannot ALTER a CHECK
-- constraint, so widening it would require a destructive rebuild that the
-- additive-only migration policy (CONTRIBUTING.md, enforced by
-- scripts/check-migrations.ts) forbids.
--
-- Same reasoning as custom_037 for the shape: no foreign key to the purged
-- intake, so the evidence outlives the row it describes. Nothing here is PHI
-- — resource_id is the intake's opaque id.

CREATE TABLE IF NOT EXISTS pharmacy_emergency_retention_purge_log (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  resource_type     TEXT NOT NULL
    CHECK (resource_type IN ('emergency_intake')),
  resource_id       TEXT NOT NULL,
  -- The intake's created_at, copied verbatim, so an audit can confirm the
  -- row was actually past the account's own retention_days boundary.
  age_reference_at  TEXT NOT NULL,
  retention_days    INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
  purged_at         TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_retention_purge_log_purged
  ON pharmacy_emergency_retention_purge_log (purged_at, resource_type);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_retention_purge_log_account
  ON pharmacy_emergency_retention_purge_log (line_account_id, purged_at);

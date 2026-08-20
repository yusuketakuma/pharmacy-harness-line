-- H-5. Durable record of what the PHI retention purge deleted.
--
-- The business decision (2026-08-19) is a uniform 3-year retention for all
-- PHI, extending the 薬剤師法施行規則 3-year duty for 調剤録/調剤済み処方箋 to
-- every PHI-bearing store. See docs/custom/pharmacy/RETENTION_MATRIX.md.
--
-- This log deliberately does NOT reference the purged row: a foreign key
-- would either block the delete or cascade the evidence away with it. The
-- point of the log is to outlive the data it describes, so a later audit can
-- show that a specific object was deleted by the retention rule (and not by a
-- bug, an operator, or an intrusion) without retaining the PHI itself.
--
-- Nothing here is PHI. `resource_id` is a server-generated UUID and `r2_key`
-- is `custom/pharmacy/prescriptions/tenants/{tenantId}/{submissionId}/{revision}/{fileId}`
-- — all opaque identifiers, no patient name, image bytes, or clinical content.

CREATE TABLE IF NOT EXISTS pharmacy_phi_retention_purge_log (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT,
  line_account_id   TEXT,
  resource_type     TEXT NOT NULL
    CHECK (resource_type IN ('prescription_file')),
  resource_id       TEXT NOT NULL,
  r2_key            TEXT,
  -- The timestamp the 3-year boundary was measured against, copied verbatim
  -- from the purged row. Without it the log cannot prove the row was actually
  -- past retention rather than deleted early.
  age_reference_at  TEXT NOT NULL,
  retention_years   INTEGER NOT NULL CHECK (retention_years >= 1),
  purged_at         TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_phi_retention_purge_log_purged
  ON pharmacy_phi_retention_purge_log (purged_at, resource_type);

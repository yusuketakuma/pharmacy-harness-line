-- Emergency contraception Phase 1: PHI-minimal provisional intake only.
-- Final eligibility and the statutory/product-specific sale record remain on paper.

CREATE TABLE IF NOT EXISTS pharmacy_emergency_settings (
  line_account_id              TEXT PRIMARY KEY,
  is_enabled                   INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  pharmacy_registration_number TEXT NOT NULL,
  product_code                 TEXT NOT NULL,
  manufacturer_check_url       TEXT NOT NULL,
  privacy_policy_url           TEXT NOT NULL,
  privacy_contact              TEXT NOT NULL,
  purpose_text                 TEXT NOT NULL,
  consent_version              TEXT NOT NULL,
  retention_days               INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
  consultation_minutes         INTEGER NOT NULL CHECK (consultation_minutes BETWEEN 1 AND 180),
  reservation_ttl_minutes      INTEGER NOT NULL CHECK (reservation_ttl_minutes BETWEEN 5 AND 1440),
  privacy_space_ready          INTEGER NOT NULL DEFAULT 0 CHECK (privacy_space_ready IN (0, 1)),
  drinking_water_ready         INTEGER NOT NULL DEFAULT 0 CHECK (drinking_water_ready IN (0, 1)),
  partner_clinic_url           TEXT NOT NULL,
  support_center_url           TEXT NOT NULL,
  updated_by                   TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_pharmacists (
  line_account_id              TEXT NOT NULL,
  staff_id                     TEXT NOT NULL,
  training_registration_number TEXT NOT NULL,
  is_active                    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  PRIMARY KEY (line_account_id, staff_id),
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_inventory (
  line_account_id TEXT NOT NULL,
  product_code    TEXT NOT NULL,
  on_hand         INTEGER NOT NULL CHECK (on_hand >= 0),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, product_code),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_slots (
  id                  TEXT PRIMARY KEY,
  line_account_id     TEXT NOT NULL,
  pharmacist_staff_id TEXT NOT NULL,
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'cancelled')),
  capacity            INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 20),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, pharmacist_staff_id, starts_at),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (line_account_id, pharmacist_staff_id)
    REFERENCES pharmacy_emergency_pharmacists(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, created_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_slots_available
  ON pharmacy_emergency_slots (line_account_id, status, starts_at, id);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_intakes (
  id                  TEXT PRIMARY KEY,
  reference_code      TEXT NOT NULL UNIQUE CHECK (length(reference_code) BETWEEN 12 AND 64),
  tenant_id           TEXT NOT NULL,
  line_account_id     TEXT NOT NULL,
  owner_friend_id     TEXT NOT NULL,
  slot_id             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'provisional'
    CHECK (status IN ('provisional', 'reviewed', 'completed', 'cancelled', 'expired')),
  encrypted_payload   TEXT NOT NULL,
  payload_key_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_key_version >= 1),
  age_band            TEXT NOT NULL CHECK (age_band IN ('under_16', '16_17', 'adult')),
  safe_contact_mode   TEXT NOT NULL
    CHECK (safe_contact_mode IN ('neutral_line', 'no_notification', 'phone', 'none')),
  consent_version     TEXT NOT NULL,
  risk_flags_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags_json)),
  -- Product the hold was taken against, captured from pharmacy_emergency_settings
  -- at creation time. An account may stock several products at once, and settings
  -- only point at the currently active one, so completion must not re-resolve it.
  product_code        TEXT,
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  expires_at          TEXT NOT NULL,
  reviewed_by         TEXT,
  reviewed_at         TEXT,
  closed_by           TEXT,
  closed_at           TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (slot_id, line_account_id)
    REFERENCES pharmacy_emergency_slots(id, line_account_id),
  FOREIGN KEY (line_account_id, reviewed_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, closed_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_intakes_queue
  ON pharmacy_emergency_intakes (line_account_id, status, expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_intakes_owner
  ON pharmacy_emergency_intakes (line_account_id, owner_friend_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_intake_events (
  id              TEXT PRIMARY KEY,
  intake_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('created', 'reviewed', 'completed', 'cancelled', 'expired')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('patient', 'staff', 'system')),
  actor_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at     TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_events_intake
  ON pharmacy_emergency_intake_events (line_account_id, intake_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_admin_events (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type = 'inventory_updated'),
  aggregate_id      TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
  on_hand           INTEGER NOT NULL CHECK (on_hand >= 0),
  occurred_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id, actor_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_admin_events_account
  ON pharmacy_emergency_admin_events (line_account_id, occurred_at, id);

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_intake_readiness
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_settings AS settings
    INNER JOIN pharmacy_emergency_slots AS slot
            ON slot.id = NEW.slot_id
           AND slot.line_account_id = settings.line_account_id
           AND slot.status = 'open'
           AND slot.starts_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
            ON pharmacist.line_account_id = slot.line_account_id
           AND pharmacist.staff_id = slot.pharmacist_staff_id
           AND pharmacist.is_active = 1
   WHERE settings.line_account_id = NEW.line_account_id
     AND settings.is_enabled = 1
     AND settings.privacy_space_ready = 1
     AND settings.drinking_water_ready = 1
     AND length(trim(settings.pharmacy_registration_number)) > 0
     AND length(trim(settings.product_code)) > 0
     AND length(trim(settings.manufacturer_check_url)) > 0
     AND length(trim(settings.privacy_policy_url)) > 0
     AND length(trim(settings.privacy_contact)) > 0
     AND length(trim(settings.partner_clinic_url)) > 0
     AND length(trim(settings.support_center_url)) > 0
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SERVICE_NOT_READY'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_intake_slot_capacity
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN (
  SELECT COUNT(*)
    FROM pharmacy_emergency_intakes AS active
   WHERE active.line_account_id = NEW.line_account_id
     AND active.slot_id = NEW.slot_id
     AND active.status IN ('provisional', 'reviewed')
     AND active.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) >= COALESCE((
  SELECT slot.capacity
    FROM pharmacy_emergency_slots AS slot
   WHERE slot.id = NEW.slot_id AND slot.line_account_id = NEW.line_account_id
), 0)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SLOT_UNAVAILABLE'); END;

-- Stock is held and consumed per product. All three stock triggers below resolve
-- against NEW.product_code, the product recorded on the intake row itself.
-- The row carries it because the writer copies pharmacy_emergency_settings.product_code
-- into the same INSERT, so at creation time NEW.product_code IS the live setting;
-- afterwards the row keeps pointing at the product that was actually reserved even
-- if an admin repoints settings at another stocked product. A live settings lookup
-- at completion time would guard and decrement the wrong inventory row.
-- NEW.product_code IS NULL never matches an inventory row, so an intake inserted
-- without one is rejected by the creation guard rather than silently unbacked.
CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_intake_stock
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN (
  SELECT COUNT(*)
    FROM pharmacy_emergency_intakes AS active
   WHERE active.line_account_id = NEW.line_account_id
     AND active.product_code = NEW.product_code
     AND active.status IN ('provisional', 'reviewed')
     AND active.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) >= COALESCE((
  SELECT inventory.on_hand
    FROM pharmacy_emergency_inventory AS inventory
   WHERE inventory.line_account_id = NEW.line_account_id
     AND inventory.product_code = NEW.product_code
), 0)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_STOCK_UNAVAILABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_completion_stock_guard
BEFORE UPDATE OF status ON pharmacy_emergency_intakes
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_inventory AS inventory
   WHERE inventory.line_account_id = NEW.line_account_id
     AND inventory.product_code = NEW.product_code
     AND inventory.on_hand > 0
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_STOCK_UNAVAILABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_completion_consume_stock
AFTER UPDATE OF status ON pharmacy_emergency_intakes
WHEN NEW.status = 'completed' AND OLD.status <> 'completed'
BEGIN UPDATE pharmacy_emergency_inventory
     SET on_hand = on_hand - 1,
         version = version + 1,
         updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND product_code = NEW.product_code; END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_events_no_update
BEFORE UPDATE ON pharmacy_emergency_intake_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_events_no_delete
BEFORE DELETE ON pharmacy_emergency_intake_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_admin_events_no_update
BEFORE UPDATE ON pharmacy_emergency_admin_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_admin_events_no_delete
BEFORE DELETE ON pharmacy_emergency_admin_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

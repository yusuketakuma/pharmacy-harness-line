-- Pharmacy v0.29 patient capability expansion and legacy emergency mirror.
-- The companion revision table keeps this additive and safely rerunnable.

CREATE TABLE IF NOT EXISTS pharmacy_account_capability_revisions (
  line_account_id TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_account_capabilities(line_account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_intake_access_events (
  id              TEXT PRIMARY KEY,
  intake_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  accessed_at     TEXT NOT NULL,
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_access_intake
  ON pharmacy_emergency_intake_access_events
    (line_account_id, intake_id, accessed_at, id);

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_intake_active_assignment
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_slots AS slot
    INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
            ON pharmacist.line_account_id = slot.line_account_id
           AND pharmacist.staff_id = slot.pharmacist_staff_id
           AND pharmacist.is_active = 1
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = pharmacist.line_account_id
           AND assignment.staff_id = pharmacist.staff_id
           AND assignment.is_active = 1
   WHERE slot.id = NEW.slot_id AND slot.line_account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SERVICE_NOT_READY'); END;

-- Preserve the v0.28 patient-facing pharmacy-information exposure.
UPDATE pharmacy_account_capabilities
   SET capabilities_json = json_insert(capabilities_json, '$[#]', 'pharmacy_info')
 WHERE mode = 'pharmacy'
   AND NOT EXISTS (
     SELECT 1 FROM json_each(capabilities_json)
      WHERE value = 'pharmacy_info'
   )
   AND NOT EXISTS (
     SELECT 1 FROM pharmacy_account_capability_revisions AS revision
      WHERE revision.line_account_id = pharmacy_account_capabilities.line_account_id
   );

-- Existing emergency exposure is authoritative for the one-time backfill.
UPDATE pharmacy_account_capabilities
   SET capabilities_json = json_insert(capabilities_json, '$[#]', 'emergency_contraception')
 WHERE EXISTS (
     SELECT 1 FROM pharmacy_emergency_settings AS settings
      WHERE settings.line_account_id = pharmacy_account_capabilities.line_account_id
        AND settings.is_enabled = 1
   )
   AND NOT EXISTS (
     SELECT 1 FROM json_each(capabilities_json)
      WHERE value = 'emergency_contraception'
   )
   AND NOT EXISTS (
     SELECT 1 FROM pharmacy_account_capability_revisions AS revision
      WHERE revision.line_account_id = pharmacy_account_capabilities.line_account_id
   );

UPDATE pharmacy_account_capabilities
   SET capabilities_json = COALESCE((
     SELECT json_group_array(value)
       FROM json_each(pharmacy_account_capabilities.capabilities_json)
      WHERE value <> 'emergency_contraception'
   ), '[]')
 WHERE EXISTS (
     SELECT 1 FROM pharmacy_emergency_settings AS settings
      WHERE settings.line_account_id = pharmacy_account_capabilities.line_account_id
        AND settings.is_enabled = 0
   )
   AND EXISTS (
     SELECT 1 FROM json_each(capabilities_json)
      WHERE value = 'emergency_contraception'
   )
   AND NOT EXISTS (
     SELECT 1 FROM pharmacy_account_capability_revisions AS revision
      WHERE revision.line_account_id = pharmacy_account_capabilities.line_account_id
   );

INSERT OR IGNORE INTO pharmacy_account_capability_revisions
  (line_account_id, revision, updated_at)
SELECT line_account_id, 1, updated_at
  FROM pharmacy_account_capabilities;

DROP TRIGGER IF EXISTS line_accounts_default_pharmacy_capability;
CREATE TRIGGER line_accounts_default_pharmacy_capability
AFTER INSERT ON line_accounts
BEGIN
  INSERT OR IGNORE INTO pharmacy_account_capabilities
    (line_account_id, mode, capabilities_json, proactive_monthly_limit,
     unfollow_alert_state, created_at, updated_at)
  VALUES (
    NEW.id, 'pharmacy',
    '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","manual_chat","pharmacy_info","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]',
    1, 'alert_only',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_capability_revision_insert
AFTER INSERT ON pharmacy_account_capabilities
BEGIN
  INSERT OR IGNORE INTO pharmacy_account_capability_revisions
    (line_account_id, revision, updated_at)
  VALUES (NEW.line_account_id, 1, NEW.updated_at); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_capability_revision_update
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN OLD.capabilities_json <> NEW.capabilities_json
BEGIN
  INSERT INTO pharmacy_account_capability_revisions
    (line_account_id, revision, updated_at)
  VALUES (NEW.line_account_id, 1, NEW.updated_at)
  ON CONFLICT(line_account_id) DO UPDATE SET
    revision = revision + 1,
    updated_at = NEW.updated_at; END;

DROP TRIGGER IF EXISTS pharmacy_capability_emergency_mirror;
CREATE TRIGGER IF NOT EXISTS pharmacy_capability_emergency_mirror_enable
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.capabilities_json)
   WHERE value = 'emergency_contraception'
)
BEGIN
  UPDATE pharmacy_emergency_settings
     SET is_enabled = 1, updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND is_enabled = 0; END;

CREATE TRIGGER IF NOT EXISTS pharmacy_capability_emergency_mirror_disable
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM json_each(NEW.capabilities_json)
   WHERE value = 'emergency_contraception'
)
BEGIN
  UPDATE pharmacy_emergency_settings
     SET is_enabled = 0, updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND is_enabled = 1; END;

DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_insert;
DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_update;
DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_insert_enable;
DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_insert_disable;
DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_update_enable;
DROP TRIGGER IF EXISTS pharmacy_emergency_capability_mirror_update_disable;

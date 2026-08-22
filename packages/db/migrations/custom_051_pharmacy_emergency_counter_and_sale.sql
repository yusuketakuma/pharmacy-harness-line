-- EC_PREVISIT_FORM.md §5 Phase B: in-store counter confirmation and the
-- statutory, immutable sale record. Additive only (CONTRIBUTING.md
-- §Migration Policy, enforced by scripts/check-migrations.ts) — no ALTER of
-- an existing CHECK, no destructive rebuild of custom_035's intake table.
--
-- The pharmacist reconciles the patient's self-reported A-D sections against
-- the in-person interview one section at a time; only the section-level
-- confirmation and any noted mismatch are recorded here, never the answers
-- themselves (those stay sealed in pharmacy_emergency_intakes.encrypted_payload).
--
-- The sale record is the statutory record required by 医薬総発 0331 第2号
-- 4(3) alongside the manufacturer's paper checklist (this table does not
-- replace the paper). It is immutable once written: a sale outcome is
-- corrected by contacting support, not by editing history. Clinical
-- determination detail (pregnancy test result, refusal reason, referral,
-- explained items) is sealed in determination_encrypted per §4 of
-- EC_PREVISIT_FORM.md; no plaintext columns exist for it here.

CREATE TABLE IF NOT EXISTS pharmacy_emergency_counter_confirmations (
  line_account_id      TEXT NOT NULL,
  intake_id             TEXT NOT NULL,
  section                TEXT NOT NULL CHECK (section IN ('A', 'B', 'C', 'D')),
  checklist_version     TEXT NOT NULL,
  mismatch_items_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mismatch_items_json)),
  staff_id                TEXT NOT NULL,
  confirmed_at           TEXT NOT NULL,
  PRIMARY KEY (line_account_id, intake_id, section),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id),
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE IF NOT EXISTS pharmacy_emergency_sale_records (
  id                            TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL,
  intake_id                     TEXT NOT NULL,
  -- Kept alongside intake_id (not resolved via join) so the legal-hold query
  -- against pharmacy_data_subject_requests(line_account_id, owner_friend_id)
  -- stays a plain equality lookup even if the intake row is later redacted.
  owner_friend_id               TEXT NOT NULL,
  product_code                  TEXT NOT NULL,
  checklist_version             TEXT NOT NULL,
  quantity                       INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
  outcome                        TEXT NOT NULL CHECK (outcome IN ('sold', 'refused')),
  identity_check                 TEXT NOT NULL
    CHECK (identity_check IN ('document', 'verbal', 'unverified')),
  in_person_dose                 TEXT NOT NULL CHECK (in_person_dose IN ('done', 'not_done')),
  checklist_sheets_received     INTEGER NOT NULL DEFAULT 0 CHECK (checklist_sheets_received >= 0),
  pharmacist_staff_id            TEXT NOT NULL,
  -- Copied from pharmacy_emergency_pharmacists at sale time, same reasoning
  -- as custom_035's intake.product_code snapshot: the statutory record must
  -- keep pointing at the registration that was actually live at sale time.
  training_registration_number  TEXT NOT NULL,
  determination_encrypted        TEXT NOT NULL,
  determination_key_version      INTEGER NOT NULL DEFAULT 1 CHECK (determination_key_version >= 1),
  sold_at                         TEXT NOT NULL,
  created_at                      TEXT NOT NULL,
  UNIQUE (line_account_id, intake_id),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (line_account_id, pharmacist_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_sale_records_sold_at
  ON pharmacy_emergency_sale_records (line_account_id, sold_at);

-- owner_friend_id cannot be pinned to the intake's own owner via a composite
-- FK (pharmacy_emergency_intakes has no UNIQUE(owner_friend_id, id,
-- line_account_id) to target, and SQLite CHECK constraints may not contain
-- subqueries), so it is enforced with a BEFORE INSERT guard instead.
CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_sale_owner_match
BEFORE INSERT ON pharmacy_emergency_sale_records
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_intakes AS intake
   WHERE intake.id = NEW.intake_id
     AND intake.line_account_id = NEW.line_account_id
     AND intake.owner_friend_id = NEW.owner_friend_id
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_OWNER_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_sale_records_no_update
BEFORE UPDATE ON pharmacy_emergency_sale_records
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_RECORD_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_sale_records_no_delete
BEFORE DELETE ON pharmacy_emergency_sale_records
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_RECORD_IMMUTABLE'); END;

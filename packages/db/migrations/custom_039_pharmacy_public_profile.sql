-- Account-scoped public pharmacy information shown to verified LIFF users.
-- Contains no patient/staff PHI; writes are still constrained to an assigned
-- owner/admin by the composite pharmacy_staff_accounts foreign key.

CREATE TABLE pharmacy_public_profiles (
  line_account_id TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  phone           TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  postal_code     TEXT NOT NULL DEFAULT '' CHECK (length(postal_code) <= 16),
  address         TEXT NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 500),
  business_hours  TEXT NOT NULL CHECK (length(trim(business_hours)) BETWEEN 1 AND 2000),
  closure_notice  TEXT NOT NULL DEFAULT '' CHECK (length(closure_notice) <= 1000),
  access_note     TEXT NOT NULL DEFAULT '' CHECK (length(access_note) <= 1000),
  parking_note    TEXT NOT NULL DEFAULT '' CHECK (length(parking_note) <= 1000),
  google_maps_url TEXT NOT NULL DEFAULT '' CHECK (length(google_maps_url) <= 2000),
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

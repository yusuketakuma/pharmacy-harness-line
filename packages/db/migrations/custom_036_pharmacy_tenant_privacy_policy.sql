-- Per-tenant (pharmacy) APPI notice: purpose of use, contact point, entrustment.
--
-- 個人情報取扱事業者 is the pharmacy tenant itself, not the platform operator.
-- The platform is the 受託者 (processor) acting under the pharmacy's instruction,
-- so every legally-facing string here is authored and owned by the tenant. The
-- platform never supplies default text naming itself as the controller.
--
-- Scoped by line_account_id, matching pharmacy_emergency_settings and every other
-- pharmacy_* settings table: the pharmacy tenant boundary in this codebase is the
-- LINE account, and pharmacy_patient_intake_responses (where the consent proof is
-- captured) is keyed the same way, so no tenant_line_accounts join is needed.
--
-- policy_version is a monotonic integer bumped by the Worker only when
-- content_hash changes; content_hash is the SHA-256 of the canonical policy text,
-- so a stored (version, hash) pair proves which text a patient actually agreed to.

CREATE TABLE IF NOT EXISTS pharmacy_tenant_privacy_policy (
  line_account_id  TEXT PRIMARY KEY,
  purpose_text     TEXT NOT NULL CHECK (length(trim(purpose_text)) BETWEEN 1 AND 4000),
  purpose_url      TEXT NOT NULL DEFAULT '' CHECK (length(purpose_url) <= 2000),
  contact_point    TEXT NOT NULL CHECK (length(trim(contact_point)) BETWEEN 1 AND 1000),
  entrustment_text TEXT NOT NULL CHECK (length(trim(entrustment_text)) BETWEEN 1 AND 2000),
  policy_version   INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  content_hash     TEXT NOT NULL CHECK (length(content_hash) = 64),
  updated_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

-- Consent proof: the policy identity in effect at the moment the patient consented.
-- Nullable because a tenant may not have published a notice yet — intake must not be
-- blocked on it (H-4: the URL column itself is not a statutory blocking requirement).
ALTER TABLE pharmacy_patient_intake_responses
  ADD COLUMN privacy_policy_version INTEGER;

ALTER TABLE pharmacy_patient_intake_responses
  ADD COLUMN privacy_policy_hash TEXT;

CREATE TABLE pharmacy_beta_notification_bindings (
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  retry_key             TEXT NOT NULL CHECK (length(retry_key) BETWEEN 8 AND 160),
  participant_friend_id TEXT NOT NULL,
  subject_patient_id    TEXT NOT NULL,
  subject_owner_friend_id TEXT NOT NULL,
  membership_id         TEXT NOT NULL REFERENCES pharmacy_beta_memberships(id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  PRIMARY KEY (line_account_id, retry_key)
);

CREATE INDEX idx_pharmacy_beta_notification_bindings_membership
  ON pharmacy_beta_notification_bindings(line_account_id, membership_id);

CREATE TRIGGER pharmacy_beta_notification_binding_scope
BEFORE INSERT ON pharmacy_beta_notification_bindings
WHEN NOT EXISTS (SELECT 1 FROM pharmacy_beta_memberships AS membership
                  WHERE membership.id = NEW.membership_id
                    AND membership.line_account_id = NEW.line_account_id
                    AND membership.participant_friend_id = NEW.participant_friend_id
                    AND membership.subject_patient_id = NEW.subject_patient_id
                    AND membership.subject_owner_friend_id = NEW.subject_owner_friend_id)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_BETA_NOTIFICATION_BINDING_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_beta_notification_binding_immutable_update
BEFORE UPDATE ON pharmacy_beta_notification_bindings
BEGIN SELECT RAISE(ABORT, 'PHARMACY_BETA_NOTIFICATION_BINDING_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_beta_notification_binding_immutable_delete
BEFORE DELETE ON pharmacy_beta_notification_bindings
BEGIN SELECT RAISE(ABORT, 'PHARMACY_BETA_NOTIFICATION_BINDING_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_beta_notification_binding_followup_insert
AFTER INSERT ON pharmacy_medication_followups
WHEN EXISTS (SELECT 1 FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = NEW.line_account_id
                AND capability.mode = 'pharmacy'
                AND capability.beta_enabled = 1)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT NEW.line_account_id, 'medication-followup:' || NEW.id,
         membership.participant_friend_id, membership.subject_patient_id,
         membership.subject_owner_friend_id, membership.id, NEW.created_at
    FROM pharmacy_beta_memberships AS membership
   WHERE membership.line_account_id = NEW.line_account_id
     AND membership.participant_friend_id = NEW.owner_friend_id
     AND membership.subject_patient_id = NEW.patient_id
     AND membership.status IN ('active', 'suspended')
     AND membership.starts_at <= NEW.created_at
     AND membership.expires_at > NEW.created_at
   ORDER BY membership.created_at DESC, membership.id DESC
   LIMIT 1; END;

CREATE TRIGGER pharmacy_beta_notification_binding_next_intake_insert
AFTER INSERT ON pharmacy_next_intake_expectations
WHEN EXISTS (SELECT 1 FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = NEW.line_account_id
                AND capability.mode = 'pharmacy'
                AND capability.beta_enabled = 1)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT NEW.line_account_id, 'next-intake:' || NEW.id,
         membership.participant_friend_id, membership.subject_patient_id,
         membership.subject_owner_friend_id, membership.id, NEW.created_at
    FROM pharmacy_beta_memberships AS membership
   WHERE membership.line_account_id = NEW.line_account_id
     AND membership.participant_friend_id = NEW.owner_friend_id
     AND membership.subject_patient_id = NEW.patient_id
     AND membership.status IN ('active', 'suspended')
     AND membership.starts_at <= NEW.created_at
     AND membership.expires_at > NEW.created_at
   ORDER BY membership.created_at DESC, membership.id DESC
   LIMIT 1; END;

CREATE TRIGGER pharmacy_beta_notification_binding_status_event_insert
AFTER INSERT ON pharmacy_prescription_events
WHEN NEW.event_type = 'status_changed'
 AND EXISTS (SELECT 1 FROM pharmacy_prescription_submissions AS submission
              INNER JOIN pharmacy_prescription_patients AS patient_link
                      ON patient_link.submission_id = submission.id
                     AND patient_link.line_account_id = submission.line_account_id
                     AND patient_link.owner_friend_id = submission.friend_id
              INNER JOIN pharmacy_account_capabilities AS capability
                      ON capability.line_account_id = submission.line_account_id
                     AND capability.mode = 'pharmacy'
                     AND capability.beta_enabled = 1
             WHERE submission.id = NEW.submission_id)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT submission.line_account_id, NEW.id, membership.participant_friend_id,
         membership.subject_patient_id, membership.subject_owner_friend_id,
         membership.id, NEW.created_at
    FROM pharmacy_prescription_submissions AS submission
    INNER JOIN pharmacy_prescription_patients AS patient_link
            ON patient_link.submission_id = submission.id
           AND patient_link.line_account_id = submission.line_account_id
           AND patient_link.owner_friend_id = submission.friend_id
    INNER JOIN pharmacy_beta_memberships AS membership
            ON membership.line_account_id = submission.line_account_id
           AND membership.participant_friend_id = submission.friend_id
           AND membership.subject_patient_id = patient_link.patient_id
           AND membership.status IN ('active', 'suspended')
           AND membership.starts_at <= NEW.created_at
           AND membership.expires_at > NEW.created_at
   WHERE submission.id = NEW.submission_id
   ORDER BY membership.created_at DESC, membership.id DESC
   LIMIT 1; END;

CREATE TRIGGER pharmacy_beta_notification_binding_patient_link_insert
AFTER INSERT ON pharmacy_prescription_patients
WHEN EXISTS (SELECT 1 FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = NEW.line_account_id
                AND capability.mode = 'pharmacy'
                AND capability.beta_enabled = 1)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT submission.line_account_id, event.id, membership.participant_friend_id,
         membership.subject_patient_id, membership.subject_owner_friend_id,
         membership.id, NEW.created_at
    FROM pharmacy_prescription_events AS event
    INNER JOIN pharmacy_prescription_submissions AS submission
            ON submission.id = event.submission_id
           AND submission.line_account_id = NEW.line_account_id
           AND submission.friend_id = NEW.owner_friend_id
    INNER JOIN pharmacy_beta_memberships AS membership
            ON membership.line_account_id = NEW.line_account_id
           AND membership.participant_friend_id = NEW.owner_friend_id
           AND membership.subject_patient_id = NEW.patient_id
           AND membership.status IN ('active', 'suspended')
           AND membership.starts_at <= event.created_at
           AND membership.expires_at > event.created_at
   WHERE event.event_type = 'status_changed'
     AND event.submission_id = NEW.submission_id
   ORDER BY membership.created_at DESC, membership.id DESC; END;

CREATE TRIGGER pharmacy_beta_notification_binding_validity_insert
AFTER INSERT ON pharmacy_prescription_validities
WHEN NEW.verification_status = 'verified'
 AND NEW.valid_until IS NOT NULL
 AND EXISTS (SELECT 1 FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = NEW.line_account_id
                AND capability.mode = 'pharmacy'
                AND capability.beta_enabled = 1)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT submission.line_account_id,
         'prescription-validity:' || NEW.submission_id || ':' || NEW.valid_until,
         membership.participant_friend_id, membership.subject_patient_id,
         membership.subject_owner_friend_id, membership.id, NEW.created_at
    FROM pharmacy_prescription_submissions AS submission
    INNER JOIN pharmacy_prescription_patients AS patient_link
            ON patient_link.submission_id = submission.id
           AND patient_link.line_account_id = submission.line_account_id
           AND patient_link.owner_friend_id = submission.friend_id
    INNER JOIN pharmacy_beta_memberships AS membership
            ON membership.line_account_id = submission.line_account_id
           AND membership.participant_friend_id = submission.friend_id
           AND membership.subject_patient_id = patient_link.patient_id
           AND membership.status IN ('active', 'suspended')
           AND membership.starts_at <= NEW.created_at
           AND membership.expires_at > NEW.created_at
   WHERE submission.id = NEW.submission_id
   ORDER BY membership.created_at DESC, membership.id DESC
   LIMIT 1; END;

CREATE TRIGGER pharmacy_beta_notification_binding_validity_update
AFTER UPDATE OF verification_status, valid_until ON pharmacy_prescription_validities
WHEN NEW.verification_status = 'verified'
 AND NEW.valid_until IS NOT NULL
 AND EXISTS (SELECT 1 FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = NEW.line_account_id
                AND capability.mode = 'pharmacy'
                AND capability.beta_enabled = 1)
BEGIN INSERT OR IGNORE INTO pharmacy_beta_notification_bindings
  (line_account_id, retry_key, participant_friend_id, subject_patient_id,
   subject_owner_friend_id, membership_id, created_at)
  SELECT submission.line_account_id,
         'prescription-validity:' || NEW.submission_id || ':' || NEW.valid_until,
         membership.participant_friend_id, membership.subject_patient_id,
         membership.subject_owner_friend_id, membership.id, NEW.updated_at
    FROM pharmacy_prescription_submissions AS submission
    INNER JOIN pharmacy_prescription_patients AS patient_link
            ON patient_link.submission_id = submission.id
           AND patient_link.line_account_id = submission.line_account_id
           AND patient_link.owner_friend_id = submission.friend_id
    INNER JOIN pharmacy_beta_memberships AS membership
            ON membership.line_account_id = submission.line_account_id
           AND membership.participant_friend_id = submission.friend_id
           AND membership.subject_patient_id = patient_link.patient_id
           AND membership.status IN ('active', 'suspended')
           AND membership.starts_at <= NEW.updated_at
           AND membership.expires_at > NEW.updated_at
   WHERE submission.id = NEW.submission_id
   ORDER BY membership.created_at DESC, membership.id DESC
   LIMIT 1; END;

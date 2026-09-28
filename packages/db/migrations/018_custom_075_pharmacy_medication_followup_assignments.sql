ALTER TABLE pharmacy_medication_followup_events
  ADD COLUMN assignee_staff_id TEXT REFERENCES staff_members(id);

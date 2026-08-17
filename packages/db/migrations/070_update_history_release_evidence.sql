-- Store PHI-free deployment evidence on the existing update history record.
ALTER TABLE update_history
  ADD COLUMN release_evidence_json TEXT NOT NULL DEFAULT '{}';

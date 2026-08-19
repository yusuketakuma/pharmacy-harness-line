-- Continues custom_022: backstop additional unconstrained cross-table
-- references with additive triggers because the referencing columns'
-- table shapes cannot be changed safely.
--
-- M-4: pharmacy_prescription_submissions.source_handoff_id (added by
-- custom_005 via ALTER TABLE ADD COLUMN) has no constraint at all. It must
-- always point at a pharmacy_myna_handoffs row in the same line_account_id.
--
-- L-3: pharmacy_prescription_files and pharmacy_prescription_events are
-- already scoped by a native single-column FOREIGN KEY on submission_id
-- REFERENCES pharmacy_prescription_submissions(id) (see custom_001), which
-- SQLite/D1 enforce with foreign_keys pragma on. Neither table carries its
-- own line_account_id, so there is no additional tenant column that could
-- mismatch beyond the already-enforced "submission must exist" check; no
-- extra trigger is needed here (verified in
-- test/custom_025_pharmacy_tenant_integrity_v2.test.ts).

CREATE TRIGGER IF NOT EXISTS pharmacy_prescription_submissions_source_handoff_scope_insert BEFORE INSERT ON pharmacy_prescription_submissions WHEN NEW.source_handoff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_myna_handoffs AS handoff WHERE handoff.id = NEW.source_handoff_id AND handoff.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_prescription_submissions_source_handoff_scope_update BEFORE UPDATE OF source_handoff_id, line_account_id ON pharmacy_prescription_submissions WHEN NEW.source_handoff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_myna_handoffs AS handoff WHERE handoff.id = NEW.source_handoff_id AND handoff.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH'); END;

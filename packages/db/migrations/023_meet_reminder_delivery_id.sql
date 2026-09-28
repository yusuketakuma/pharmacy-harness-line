-- A reschedule rewrites the same reminder row, so the row id cannot double as
-- the LINE proxy retry key: a second-generation send would be deduped as the
-- first send's retry. delivery_id is regenerated per scheduled generation and
-- also lets the claim compare the payload version it read before sending.
ALTER TABLE meet_consultation_reminders ADD COLUMN delivery_id TEXT;

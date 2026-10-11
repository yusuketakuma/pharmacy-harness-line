-- Durable, PHI-free work metadata. State transitions enqueue atomically even
-- when the previous Worker is running. Completed history is outside the index.
CREATE TABLE IF NOT EXISTS pharmacy_status_notification_work (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  retry_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('myna', 'emergency')),
  source_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  PRIMARY KEY (line_account_id, retry_key)
);
CREATE INDEX IF NOT EXISTS idx_pharmacy_status_work_due
  ON pharmacy_status_notification_work (kind, due_at, source_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_pharmacy_status_work_expiry
  ON pharmacy_status_notification_work (kind, expires_at)
  WHERE state = 'pending';

CREATE TRIGGER IF NOT EXISTS pharmacy_myna_expired_work_insert AFTER INSERT ON pharmacy_myna_handoffs
WHEN NEW.status = 'EXPIRED'
BEGIN
  INSERT OR IGNORE INTO pharmacy_status_notification_work
    (line_account_id, retry_key, kind, source_id, due_at, expires_at)
  VALUES (NEW.line_account_id, 'myna-status:' || NEW.id || ':EXPIRED', 'myna', NEW.id,
          NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '+72 hours'));
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_myna_expired_work_update AFTER UPDATE OF status ON pharmacy_myna_handoffs
WHEN NEW.status = 'EXPIRED' AND OLD.status != 'EXPIRED'
BEGIN
  INSERT OR IGNORE INTO pharmacy_status_notification_work
    (line_account_id, retry_key, kind, source_id, due_at, expires_at)
  VALUES (NEW.line_account_id, 'myna-status:' || NEW.id || ':EXPIRED', 'myna', NEW.id,
          NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '+72 hours'));
END;
-- Staff verification can keep an already EXPIRED handoff EXPIRED while updating
-- updated_at. Preserve the previous sweep's window based on that latest time.
CREATE TRIGGER IF NOT EXISTS pharmacy_myna_expired_work_refresh AFTER UPDATE OF updated_at ON pharmacy_myna_handoffs
WHEN NEW.status = 'EXPIRED' AND OLD.status = 'EXPIRED' AND NEW.updated_at != OLD.updated_at
BEGIN
  INSERT INTO pharmacy_status_notification_work
    (line_account_id, retry_key, kind, source_id, due_at, expires_at)
  SELECT NEW.line_account_id, 'myna-status:' || NEW.id || ':EXPIRED', 'myna', NEW.id,
         NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at, '+72 hours')
   WHERE NOT EXISTS (SELECT 1 FROM pharmacy_notification_events notice
                      WHERE notice.line_account_id = NEW.line_account_id
                        AND notice.idempotency_key = 'myna-status:' || NEW.id || ':EXPIRED'
                        AND notice.outcome = 'sent')
  ON CONFLICT (line_account_id, retry_key) DO UPDATE SET
    expires_at = excluded.expires_at,
    due_at = MAX(pharmacy_status_notification_work.due_at, excluded.due_at),
    state = 'pending'
  WHERE pharmacy_status_notification_work.state != 'done';
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_status_work_insert AFTER INSERT ON pharmacy_emergency_intake_events
WHEN NEW.event_type IN ('reviewed', 'cancelled', 'expired')
BEGIN
  INSERT OR IGNORE INTO pharmacy_status_notification_work
    (line_account_id, retry_key, kind, source_id, due_at, expires_at)
  VALUES (NEW.line_account_id, 'emergency-intake-status:' || NEW.id, 'emergency', NEW.id,
          NEW.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at, '+72 hours'));
END;
-- Old/new Workers share the existing notification idempotency record. A sent
-- record also settles work, including acceptance followed by response loss.
CREATE TRIGGER IF NOT EXISTS pharmacy_status_work_sent_insert AFTER INSERT ON pharmacy_notification_events
WHEN NEW.outcome = 'sent'
BEGIN
  UPDATE pharmacy_status_notification_work SET state = 'done', claim_token = NULL
   WHERE line_account_id = NEW.line_account_id AND retry_key = NEW.idempotency_key AND state = 'pending';
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_status_work_sent_update AFTER UPDATE OF outcome ON pharmacy_notification_events
WHEN NEW.outcome = 'sent'
BEGIN
  UPDATE pharmacy_status_notification_work SET state = 'done', claim_token = NULL
   WHERE line_account_id = NEW.line_account_id AND retry_key = NEW.idempotency_key AND state = 'pending';
END;
-- Retention deletion must not leave unreachable pending metadata behind.
CREATE TRIGGER IF NOT EXISTS pharmacy_myna_status_work_source_removed AFTER DELETE ON pharmacy_myna_handoffs
BEGIN
  UPDATE pharmacy_status_notification_work SET state = 'expired', claim_token = NULL
   WHERE line_account_id = OLD.line_account_id AND retry_key = 'myna-status:' || OLD.id || ':EXPIRED' AND state = 'pending';
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_emergency_status_work_source_removed AFTER DELETE ON pharmacy_emergency_intake_events
BEGIN
  UPDATE pharmacy_status_notification_work SET state = 'expired', claim_token = NULL
   WHERE line_account_id = OLD.line_account_id AND retry_key = 'emergency-intake-status:' || OLD.id AND state = 'pending';
END;
CREATE TRIGGER IF NOT EXISTS pharmacy_myna_status_work_cancelled AFTER UPDATE OF status ON pharmacy_myna_handoffs
WHEN OLD.status = 'EXPIRED' AND NEW.status != 'EXPIRED'
BEGIN
  UPDATE pharmacy_status_notification_work SET state = 'expired', claim_token = NULL
   WHERE line_account_id = OLD.line_account_id AND retry_key = 'myna-status:' || OLD.id || ':EXPIRED' AND state = 'pending';
END;
-- One-time bounded-window backfill; these INSERTs are also safe reconciliation
-- statements if work metadata ever needs repair. Do not run them every tick.
INSERT OR IGNORE INTO pharmacy_status_notification_work
  (line_account_id, retry_key, kind, source_id, due_at, expires_at)
SELECT handoff.line_account_id, 'myna-status:' || handoff.id || ':EXPIRED', 'myna', handoff.id,
       handoff.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', handoff.updated_at, '+72 hours')
  FROM pharmacy_myna_handoffs handoff
 WHERE handoff.status = 'EXPIRED'
   AND handoff.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
   AND NOT EXISTS (SELECT 1 FROM pharmacy_notification_events notice
                   WHERE notice.line_account_id = handoff.line_account_id
                     AND notice.idempotency_key = 'myna-status:' || handoff.id || ':EXPIRED'
                     AND notice.outcome = 'sent');
INSERT OR IGNORE INTO pharmacy_status_notification_work
  (line_account_id, retry_key, kind, source_id, due_at, expires_at)
SELECT event.line_account_id, 'emergency-intake-status:' || event.id, 'emergency', event.id,
       event.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ', event.occurred_at, '+72 hours')
  FROM pharmacy_emergency_intake_events event
 WHERE event.event_type IN ('reviewed', 'cancelled', 'expired')
   AND event.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
   AND NOT EXISTS (SELECT 1 FROM pharmacy_notification_events notice
                   WHERE notice.line_account_id = event.line_account_id
                     AND notice.idempotency_key = 'emergency-intake-status:' || event.id
                     AND notice.outcome = 'sent');

-- Recovery reconciliation: repair inconsistent pending metadata after a partial
-- legacy installation. Run with the two INSERTs above when repairing; not per tick.
-- A partial installation may have missed an EXPIRED updated_at refresh before
-- the refresh trigger was installed. Restore that latest legacy notification
-- window without changing a current lease or reviving unchanged expired work.
UPDATE pharmacy_status_notification_work
 SET expires_at = (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', handoff.updated_at, '+72 hours')
                     FROM pharmacy_myna_handoffs handoff
                    WHERE handoff.id = pharmacy_status_notification_work.source_id
                      AND handoff.line_account_id = pharmacy_status_notification_work.line_account_id),
     due_at = MAX(due_at, (SELECT handoff.updated_at FROM pharmacy_myna_handoffs handoff
                           WHERE handoff.id = pharmacy_status_notification_work.source_id
                             AND handoff.line_account_id = pharmacy_status_notification_work.line_account_id)),
     state = 'pending'
 WHERE kind = 'myna' AND state != 'done' AND EXISTS (
   SELECT 1 FROM pharmacy_myna_handoffs handoff
    WHERE handoff.id = pharmacy_status_notification_work.source_id
      AND handoff.line_account_id = pharmacy_status_notification_work.line_account_id
      AND handoff.status = 'EXPIRED'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', handoff.updated_at, '+72 hours') != pharmacy_status_notification_work.expires_at
 ) AND NOT EXISTS (
   SELECT 1 FROM pharmacy_notification_events notice
    WHERE notice.line_account_id = pharmacy_status_notification_work.line_account_id
      AND notice.idempotency_key = pharmacy_status_notification_work.retry_key
      AND notice.outcome = 'sent'
 );
UPDATE pharmacy_status_notification_work SET state = 'done', claim_token = NULL
 WHERE state = 'pending' AND EXISTS (
   SELECT 1 FROM pharmacy_notification_events notice
    WHERE notice.line_account_id = pharmacy_status_notification_work.line_account_id
      AND notice.idempotency_key = pharmacy_status_notification_work.retry_key
      AND notice.outcome = 'sent'
 );
UPDATE pharmacy_status_notification_work SET state = 'expired', claim_token = NULL
 WHERE state = 'pending' AND (
   (kind = 'myna' AND NOT EXISTS (
     SELECT 1 FROM pharmacy_myna_handoffs handoff
      WHERE handoff.id = pharmacy_status_notification_work.source_id
        AND handoff.line_account_id = pharmacy_status_notification_work.line_account_id
        AND handoff.status = 'EXPIRED'
   )) OR (kind = 'emergency' AND NOT EXISTS (
     SELECT 1 FROM pharmacy_emergency_intake_events event
      WHERE event.id = pharmacy_status_notification_work.source_id
        AND event.line_account_id = pharmacy_status_notification_work.line_account_id
   ))
 );

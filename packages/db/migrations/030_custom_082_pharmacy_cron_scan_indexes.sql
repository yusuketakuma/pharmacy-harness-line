-- Global cron discovery intentionally crosses accounts. Keep existing scoped
-- indexes and authorization joins; these indexes contain no new patient data.
CREATE INDEX IF NOT EXISTS idx_outbound_open_expiry
  ON outbound_line_deliveries (retry_until)
  WHERE outcome = 'open';

CREATE INDEX IF NOT EXISTS idx_outbound_broadcast_test_replay
  ON outbound_line_deliveries (updated_at)
  WHERE outcome = 'open' AND delivery_type = 'push'
    AND source = 'broadcast' AND attempt_count > 0;

CREATE INDEX IF NOT EXISTS idx_outbound_unattempted_scenario_reply
  ON outbound_line_deliveries (id)
  WHERE outcome = 'open' AND delivery_type = 'reply'
    AND source = 'scenario' AND attempt_count = 0;

-- Both accepted and unsent repair look up only the enrollment's current claim.
CREATE INDEX IF NOT EXISTS idx_outbound_payload_scenario_claim
  ON outbound_line_delivery_payloads (scenario_enrollment_id, scenario_claim_token)
  WHERE scenario_claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friend_scenarios_paused_claim
  ON friend_scenarios (status, delivery_claim_token, id, friend_id, scenario_id, current_step_order, started_at)
  WHERE status = 'paused' AND delivery_claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pharmacy_myna_expired_notice
  ON pharmacy_myna_handoffs (updated_at, id)
  WHERE status = 'EXPIRED';

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_status_notice
  ON pharmacy_emergency_intake_events (occurred_at, id)
  WHERE event_type IN ('reviewed', 'cancelled', 'expired');

-- Lazy expiry calls retain account isolation and now skip terminal history.
CREATE INDEX IF NOT EXISTS idx_pharmacy_myna_active_expiry
  ON pharmacy_myna_handoffs (line_account_id, expires_at)
  WHERE status NOT IN ('PAPER_FALLBACK','ABANDONED','CLOSED','EXPIRED');

CREATE INDEX IF NOT EXISTS idx_pharmacy_emergency_active_expiry
  ON pharmacy_emergency_intakes (line_account_id, expires_at, id)
  WHERE status IN ('provisional', 'reviewed');

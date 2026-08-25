-- V032: emergency contraception is discoverable by default for newly created
-- pharmacy accounts. Existing capability rows are deliberately untouched, so
-- an explicit account-level OFF remains authoritative. Operational readiness
-- (settings, pharmacist, stock and slots) continues to fail closed separately.

DROP TRIGGER IF EXISTS line_accounts_default_pharmacy_capability;
CREATE TRIGGER line_accounts_default_pharmacy_capability
AFTER INSERT ON line_accounts
BEGIN
  INSERT OR IGNORE INTO pharmacy_account_capabilities
    (line_account_id, mode, capabilities_json, proactive_monthly_limit,
     unfollow_alert_state, created_at, updated_at)
  VALUES (
    NEW.id, 'pharmacy',
    '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","emergency_contraception","manual_chat","pharmacy_info","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]',
    1, 'alert_only',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ); END;

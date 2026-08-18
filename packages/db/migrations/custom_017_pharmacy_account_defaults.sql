-- Every account in this product is a pharmacy account. Keep the capability
-- boundary fail-closed for accounts created outside the tenant setup command.

INSERT OR IGNORE INTO pharmacy_account_capabilities
  (line_account_id, mode, capabilities_json, proactive_monthly_limit,
   unfollow_alert_state, created_at, updated_at)
SELECT id, 'pharmacy',
       '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","manual_chat","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]',
       1, 'alert_only',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM line_accounts;

CREATE TRIGGER IF NOT EXISTS line_accounts_default_pharmacy_capability AFTER INSERT ON line_accounts BEGIN INSERT OR IGNORE INTO pharmacy_account_capabilities (line_account_id, mode, capabilities_json, proactive_monthly_limit, unfollow_alert_state, created_at, updated_at) VALUES (NEW.id, 'pharmacy', '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","manual_chat","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]', 1, 'alert_only', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;

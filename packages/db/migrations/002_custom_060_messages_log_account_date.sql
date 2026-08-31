CREATE INDEX idx_messages_log_account_created_at
  ON messages_log(
    line_account_id,
    julianday(CASE
      WHEN created_at GLOB '*Z' OR substr(created_at, -6, 1) IN ('+', '-')
        THEN created_at
      ELSE created_at || '+09:00'
    END)
  );

CREATE INDEX idx_calendar_bookings_connection_start_instant
  ON calendar_bookings (connection_id, julianday(start_at));

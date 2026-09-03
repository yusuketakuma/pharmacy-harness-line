CREATE TABLE admin_login_throttles (
  realm               TEXT NOT NULL CHECK (realm IN ('tenant', 'platform_admin')),
  authority_id        TEXT NOT NULL CHECK (length(authority_id) BETWEEN 1 AND 128),
  login_id_normalized TEXT NOT NULL CHECK (length(login_id_normalized) BETWEEN 1 AND 128),
  failure_count       INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
  window_started_at   TEXT NOT NULL CHECK (unixepoch(window_started_at) IS NOT NULL),
  next_allowed_at     TEXT NOT NULL CHECK (unixepoch(next_allowed_at) IS NOT NULL),
  locked_until        TEXT CHECK (locked_until IS NULL OR unixepoch(locked_until) IS NOT NULL),
  updated_at          TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  PRIMARY KEY (realm, authority_id, login_id_normalized)
);

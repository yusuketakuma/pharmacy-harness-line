ALTER TABLE tenant_admin_sessions
  ADD COLUMN session_family_hash TEXT
  CHECK (session_family_hash IS NULL OR
         (length(session_family_hash) = 64
          AND session_family_hash NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE platform_admin_sessions
  ADD COLUMN session_family_hash TEXT
  CHECK (session_family_hash IS NULL OR
         (length(session_family_hash) = 64
          AND session_family_hash NOT GLOB '*[^0-9a-f]*'));

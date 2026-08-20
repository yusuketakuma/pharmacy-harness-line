-- Store staff API keys as a keyed hash (HMAC-SHA-256 under a server-side
-- secret) so a D1 read leak no longer hands out usable bearer tokens.
--
-- Additive on purpose: `api_key` keeps holding the plaintext so every key
-- issued before this migration keeps authenticating through the legacy
-- lookup while `api_key_hash` is backfilled on first successful use. Dropping
-- the plaintext column is a separate follow-up migration once the backfill is
-- complete.

ALTER TABLE staff_members ADD COLUMN api_key_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_members_api_key_hash
  ON staff_members(api_key_hash);

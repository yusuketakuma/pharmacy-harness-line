-- Keep the stable friends.id primary key while allowing one LINE user to follow
-- multiple tenant-owned LINE accounts.
ALTER TABLE friends ADD COLUMN provider_line_user_id TEXT;

UPDATE friends
   SET provider_line_user_id = line_user_id
 WHERE provider_line_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_friends_account_provider_user
  ON friends (line_account_id, provider_line_user_id)
  WHERE line_account_id IS NOT NULL AND provider_line_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_friends_unowned_provider_user
  ON friends (provider_line_user_id)
  WHERE line_account_id IS NULL AND provider_line_user_id IS NOT NULL;

-- Keep old writers fail-closed during a rolling migration. New scoped writers
-- always provide provider_line_user_id explicitly.
CREATE TRIGGER IF NOT EXISTS friends_provider_id_compat_insert AFTER INSERT ON friends WHEN NEW.provider_line_user_id IS NULL BEGIN UPDATE friends SET provider_line_user_id = NEW.line_user_id WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS friends_provider_id_required_update BEFORE UPDATE OF provider_line_user_id ON friends WHEN NEW.provider_line_user_id IS NULL BEGIN SELECT RAISE(ABORT, 'FRIEND_PROVIDER_LINE_USER_ID_REQUIRED'); END;

CREATE TRIGGER IF NOT EXISTS friends_account_immutable BEFORE UPDATE OF line_account_id ON friends WHEN OLD.line_account_id IS NOT NULL AND NEW.line_account_id IS NOT OLD.line_account_id BEGIN SELECT RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE'); END;

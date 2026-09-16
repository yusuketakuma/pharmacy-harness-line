-- Cross-scope guards for friend link tables. Application code paths exist that
-- combine a caller-supplied friend id with a tag/scenario id without verifying
-- the friend's account (e.g. /t/:linkId?f=). Reject only unambiguous
-- mismatches: rows where either side is unscoped (NULL account/tenant) keep the
-- historical legacy behavior.

CREATE TRIGGER friend_tags_tenant_scope_insert
BEFORE INSERT ON friend_tags
WHEN EXISTS (
  SELECT 1
    FROM friends AS friend
    JOIN tags AS tag ON tag.id = NEW.tag_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE friend.id = NEW.friend_id
     AND tag.tenant_id IS NOT NULL
     AND friend.line_account_id IS NOT NULL
     AND mapping.tenant_id IS NOT tag.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FRIEND_TAG_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER friend_tags_tenant_scope_update
BEFORE UPDATE OF friend_id, tag_id ON friend_tags
WHEN EXISTS (
  SELECT 1
    FROM friends AS friend
    JOIN tags AS tag ON tag.id = NEW.tag_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE friend.id = NEW.friend_id
     AND tag.tenant_id IS NOT NULL
     AND friend.line_account_id IS NOT NULL
     AND mapping.tenant_id IS NOT tag.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FRIEND_TAG_TENANT_SCOPE_MISMATCH'); END;

-- Account-scoped scenarios only enroll friends of the same account.
-- Tenant-scoped scenarios (line_account_id NULL, tenant_id set) only enroll
-- friends whose account maps to that tenant.
CREATE TRIGGER friend_scenarios_scope_insert
BEFORE INSERT ON friend_scenarios
WHEN EXISTS (
  SELECT 1
    FROM friends AS friend
    JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE friend.id = NEW.friend_id
     AND friend.line_account_id IS NOT NULL
     AND (
       (scenario.line_account_id IS NOT NULL
          AND scenario.line_account_id IS NOT friend.line_account_id)
       OR
       (scenario.line_account_id IS NULL
          AND scenario.tenant_id IS NOT NULL
          AND mapping.tenant_id IS NOT scenario.tenant_id)
     )
)
BEGIN SELECT RAISE(ABORT, 'FRIEND_SCENARIO_SCOPE_MISMATCH'); END;

CREATE TRIGGER friend_scenarios_scope_update
BEFORE UPDATE OF friend_id, scenario_id ON friend_scenarios
WHEN EXISTS (
  SELECT 1
    FROM friends AS friend
    JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE friend.id = NEW.friend_id
     AND friend.line_account_id IS NOT NULL
     AND (
       (scenario.line_account_id IS NOT NULL
          AND scenario.line_account_id IS NOT friend.line_account_id)
       OR
       (scenario.line_account_id IS NULL
          AND scenario.tenant_id IS NOT NULL
          AND mapping.tenant_id IS NOT scenario.tenant_id)
     )
)
BEGIN SELECT RAISE(ABORT, 'FRIEND_SCENARIO_SCOPE_MISMATCH'); END;

-- Deterministic pharmacy rich-menu generators are unique per LINE account.
ALTER TABLE rich_menu_groups ADD COLUMN generator_key TEXT;
ALTER TABLE rich_menu_groups ADD COLUMN generator_version TEXT;

CREATE UNIQUE INDEX uq_rich_menu_groups_account_generator
  ON rich_menu_groups (account_id, generator_key)
  WHERE generator_key IS NOT NULL;

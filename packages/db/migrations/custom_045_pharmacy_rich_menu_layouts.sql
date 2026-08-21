-- Pharmacy v0.30 account-scoped rich-menu layout and immutable draft evidence.

CREATE TABLE IF NOT EXISTS pharmacy_rich_menu_layouts (
  line_account_id      TEXT PRIMARY KEY,
  preferred_order_json TEXT NOT NULL
    CHECK (json_valid(preferred_order_json)
      AND json_type(preferred_order_json) = 'array'
      AND json_array_length(preferred_order_json) = 5),
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_account_capabilities(line_account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_rich_menu_draft_bindings (
  group_id             TEXT PRIMARY KEY,
  line_account_id      TEXT NOT NULL,
  layout_revision      INTEGER NOT NULL CHECK (layout_revision >= 1),
  capability_revision  INTEGER NOT NULL CHECK (capability_revision >= 1),
  liff_id_hash         TEXT NOT NULL CHECK (length(liff_id_hash) = 64),
  catalog_version      TEXT NOT NULL CHECK (length(catalog_version) > 0),
  menu_size            TEXT NOT NULL CHECK (menu_size IN ('large', 'compact')),
  catalog_variant_key  TEXT NOT NULL CHECK (length(catalog_variant_key) > 0),
  catalog_object_key   TEXT NOT NULL CHECK (length(catalog_object_key) > 0),
  manifest_hash        TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  image_hash           TEXT NOT NULL CHECK (length(image_hash) = 64),
  created_at           TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_rich_menu_layouts(line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_rich_menu_draft_account
  ON pharmacy_rich_menu_draft_bindings(line_account_id, created_at, group_id);

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_draft_account_scope
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id AND account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_DRAFT_ACCOUNT_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_draft_status
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id
     AND account_id = NEW.line_account_id
     AND status <> 'draft'
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_GROUP_NOT_DRAFT'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_draft_size
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id
     AND account_id = NEW.line_account_id
     AND size <> NEW.menu_size
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_GROUP_SIZE_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_draft_immutable
BEFORE UPDATE ON pharmacy_rich_menu_draft_bindings
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_DRAFT_IMMUTABLE'); END;

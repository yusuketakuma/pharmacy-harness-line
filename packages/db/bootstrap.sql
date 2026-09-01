-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.
-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.
CREATE TABLE account_health_logs (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  error_code      INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  check_period    TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'warning', 'danger')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE account_migrations (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  migrated_count   INTEGER NOT NULL DEFAULT 0,
  total_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at     TEXT
);

CREATE TABLE account_settings (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, key)
);

CREATE TABLE ad_conversion_logs (
  id                  TEXT PRIMARY KEY,
  ad_platform_id      TEXT NOT NULL,
  friend_id           TEXT NOT NULL,
  conversion_point_id TEXT,
  event_name          TEXT NOT NULL,
  click_id            TEXT,
  click_id_type       TEXT,
  status              TEXT DEFAULT 'pending',
  request_body        TEXT,
  response_body       TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE ad_platforms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

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

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliate_clicks (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  url          TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliate_links (
  id              TEXT PRIMARY KEY,
  affiliate_id    TEXT NOT NULL REFERENCES affiliates (id),
  ref_code        TEXT NOT NULL UNIQUE,
  label           TEXT,
  line_account_id TEXT REFERENCES line_accounts (id),
  offer_id        TEXT REFERENCES affiliate_offers (id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  click_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE affiliate_offers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  reward_amount   INTEGER NOT NULL DEFAULT 0,
  reward_miles    INTEGER NOT NULL DEFAULT 0,
  mileage_program_id TEXT NOT NULL DEFAULT 'default' REFERENCES mileage_programs (id),
  line_account_id TEXT REFERENCES line_accounts (id),
  tag_id          TEXT REFERENCES tags (id),
  scenario_id     TEXT REFERENCES scenarios (id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE affiliates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  friend_id       TEXT REFERENCES friends (id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE auto_replies (
  id               TEXT PRIMARY KEY,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')) DEFAULT 'exact',
  response_type    TEXT NOT NULL DEFAULT 'text',
  response_content TEXT NOT NULL,
  template_id      TEXT REFERENCES templates(id) ON DELETE SET NULL,
  line_account_id  TEXT DEFAULT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automation_logs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data     TEXT,
  actions_result TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  event_type  TEXT NOT NULL,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL                  -- UTC ISO8601
);

CREATE TABLE booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,                                -- UTC ISO8601
  sent_at       TEXT,                                         -- UTC ISO8601
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  claimed_at    TEXT,
  first_attempted_at TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE TABLE bookings (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL,
  friend_id               TEXT NOT NULL,        -- friends.id
  staff_id                TEXT NOT NULL,
  menu_id                 TEXT NOT NULL,
  starts_at               TEXT NOT NULL,        -- UTC ISO8601 (Z)
  ends_at                 TEXT NOT NULL,        -- UTC ISO8601 (Z)
  block_ends_at           TEXT NOT NULL,        -- ends_at + buffer_after。衝突判定
  status                  TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','expired','cancelled','completed','no_show')),
  customer_note           TEXT,
  internal_note           TEXT,
  price_at_booking        INTEGER NOT NULL,
  requested_at            TEXT NOT NULL,        -- UTC ISO8601
  decided_at              TEXT,                 -- UTC ISO8601
  decided_by_staff_id     TEXT,
  external_event_id       TEXT,                 -- Phase 3 余地 (Google Calendar)
  external_calendar_id    TEXT,                 -- Phase 3 余地
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE broadcast_insights (
  id                  TEXT PRIMARY KEY,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  delivered           INTEGER,
  unique_impression   INTEGER,
  unique_click        INTEGER,
  unique_media_played INTEGER,
  open_rate           REAL,
  click_rate          REAL,
  raw_response        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "broadcasts" (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids))
, dedup_progress TEXT, batch_lock_at TEXT, track_links INTEGER NOT NULL DEFAULT 1);

CREATE TABLE calendar_bookings (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES google_calendar_connections (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_id       TEXT,
  title          TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'in_progress', 'resolved')),
  notes         TEXT,
  last_message_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE conversion_events (
  id                   TEXT PRIMARY KEY,
  conversion_point_id  TEXT NOT NULL REFERENCES conversion_points (id) ON DELETE CASCADE,
  friend_id            TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  user_id              TEXT,
  affiliate_code       TEXT,
  metadata             TEXT,
  affiliate_id         TEXT REFERENCES affiliates (id),
  attributed_ref_code  TEXT,
  approval_status      TEXT CHECK (approval_status IN ('pending','approved','rejected')),
  approved_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE conversion_points (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value      REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE engagement_events (
  id                TEXT PRIMARY KEY,
  program_id        TEXT NOT NULL REFERENCES mileage_programs(id),
  idempotency_key   TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_event_id   TEXT,
  actor_user_id     TEXT REFERENCES users(id),
  actor_friend_id   TEXT REFERENCES friends(id),
  subject_user_id   TEXT REFERENCES users(id),
  subject_friend_id TEXT REFERENCES friends(id),
  identity_provider TEXT,
  identity_subject  TEXT,
  metadata          TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (program_id, idempotency_key)
);

CREATE TABLE entry_routes (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1);

CREATE TABLE event_booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL
);

CREATE TABLE event_booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  claimed_at    TEXT,
  first_attempted_at TEXT,
  FOREIGN KEY (booking_id) REFERENCES event_bookings(id)
);

CREATE TABLE event_bookings (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','cancelled','expired','no_show','attended')),
  customer_note         TEXT,
  internal_note         TEXT,
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_staff_id   TEXT,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('friend','admin','system')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), identity_key TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

CREATE TABLE event_slots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE events (
  id                            TEXT PRIMARY KEY,
  line_account_id               TEXT NOT NULL,
  name                          TEXT NOT NULL,
  venue_name                    TEXT,
  venue_url                     TEXT,
  image_url                     TEXT,
  description                   TEXT,
  description_centered          INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_friend       INTEGER,
  requires_approval             INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_hours_before  INTEGER,
  reminder_day_before_enabled   INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before         INTEGER,
  is_published                  INTEGER NOT NULL DEFAULT 0,
  folder_id                     TEXT,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                    TEXT,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup')), account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids)), dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)), failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)), confirmation_message_extra TEXT, reminder_message_extra TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE form_opens (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  friend_id TEXT,
  friend_name TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, on_submit_message_type TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL, on_submit_message_content TEXT DEFAULT NULL, on_submit_webhook_url TEXT, on_submit_webhook_headers TEXT, on_submit_webhook_fail_message TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT);

CREATE TABLE friend_reminder_deliveries (
  id                TEXT PRIMARY KEY,
  friend_reminder_id TEXT NOT NULL REFERENCES friend_reminders (id) ON DELETE CASCADE,
  reminder_step_id  TEXT NOT NULL REFERENCES reminder_steps (id) ON DELETE CASCADE,
  delivered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_reminder_id, reminder_step_id)
);

CREATE TABLE friend_reminders (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  target_date     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "friend_scenarios" (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'delivering')) DEFAULT 'active',
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  next_delivery_at   TEXT,
  delivery_first_attempted_at TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, delivery_claim_token TEXT);

CREATE TABLE friend_scores (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scoring_rule_id TEXT REFERENCES scoring_rules (id) ON DELETE SET NULL,
  score_change    INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);

CREATE TABLE friends (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  ig_igsid         TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  last_ref_code    TEXT,
  last_ref_at      TEXT,
  first_followed_at TEXT,
  current_follow_started_at TEXT,
  last_followed_at TEXT,
  last_unfollowed_at TEXT,
  unfollow_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ref_code TEXT, metadata TEXT NOT NULL DEFAULT '{}', line_account_id TEXT REFERENCES line_accounts(id), first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL, provider_line_user_id TEXT);

CREATE TABLE google_calendar_connections (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  calendar_id   TEXT NOT NULL,
  line_account_id TEXT,
  staff_id      TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  api_key       TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'api_key',
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE incoming_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'custom',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT);

CREATE TABLE line_accounts (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  channel_access_token   TEXT NOT NULL,
  channel_secret         TEXT NOT NULL,
  is_active              INTEGER NOT NULL DEFAULT 1,
  country                TEXT,
  role                   TEXT,
  display_order          INTEGER NOT NULL DEFAULT 0,
  og_site_name           TEXT,
  og_default_image_url   TEXT,
  og_default_description TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, token_expires_at TEXT);

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media_inquiries (
  id TEXT PRIMARY KEY,
  inquiry_type TEXT NOT NULL,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  department TEXT,
  position TEXT,
  decision_role TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  company_size TEXT,
  current_tools TEXT,
  line_friend_count TEXT,
  budget TEXT,
  timeframe TEXT,
  challenge TEXT NOT NULL,
  desired_outcome TEXT,
  preferred_contact TEXT,
  source_article TEXT,
  source_url TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  country TEXT,
  cf_ray TEXT,
  mail_status TEXT NOT NULL DEFAULT 'pending',
  mail_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meet_consultation_reminders (
  id               TEXT PRIMARY KEY,
  consultation_id  TEXT NOT NULL REFERENCES meet_consultations (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('day_before', 'hour_before')),
  scheduled_at     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'failed', 'sent', 'cancelled')),
  retry_count      INTEGER NOT NULL DEFAULT 0,
  sent_at          TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (consultation_id, kind)
);

CREATE TABLE meet_consultations (
  id                TEXT PRIMARY KEY,
  external_event_id TEXT NOT NULL UNIQUE,
  friend_id         TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  meet_url          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE menus (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category_label        TEXT,
  description           TEXT,
  duration_minutes      INTEGER NOT NULL,
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0,
  base_price            INTEGER NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  auto_tag_id           TEXT,                  -- 予約申込時に friend に自動付与するタグ
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (auto_tag_id) REFERENCES tags(id) ON DELETE SET NULL
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages_log (
  id               TEXT PRIMARY KEY,
  friend_id        TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type     TEXT NOT NULL,
  content          TEXT NOT NULL,
  broadcast_id     TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  template_id_at_send TEXT,
  delivery_type    TEXT CHECK (delivery_type IN ('push', 'reply', 'test')),
  source           TEXT,
  line_account_id  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, outbound_operation_id TEXT REFERENCES outbound_line_deliveries(id) ON DELETE SET NULL);

CREATE TABLE mileage_event_queue (
  engagement_event_id   TEXT PRIMARY KEY REFERENCES engagement_events(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','processed','failed')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  available_at          TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at          TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE mileage_ledger (
  id                    TEXT PRIMARY KEY,
  program_id            TEXT NOT NULL REFERENCES mileage_programs(id),
  beneficiary_user_id   TEXT REFERENCES users(id),
  beneficiary_friend_id TEXT REFERENCES friends(id),
  engagement_event_id   TEXT REFERENCES engagement_events(id),
  mileage_rule_id       TEXT REFERENCES mileage_rules(id),
  entry_type            TEXT NOT NULL
                        CHECK (entry_type IN ('grant','reversal','spend','expiration','adjustment')),
  status                TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('pending','available','void')),
  amount                INTEGER NOT NULL CHECK (amount != 0),
  reason                TEXT NOT NULL,
  source                TEXT NOT NULL,
  source_event_id       TEXT,
  idempotency_key       TEXT NOT NULL,
  reverses_entry_id     TEXT REFERENCES mileage_ledger(id),
  metadata              TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (program_id, idempotency_key)
);

CREATE TABLE mileage_programs (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','paused','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mileage_rules (
  id             TEXT PRIMARY KEY,
  program_id     TEXT NOT NULL REFERENCES mileage_programs(id),
  name           TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  source         TEXT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  initial_status TEXT NOT NULL DEFAULT 'available'
                 CHECK (initial_status IN ('pending','available')),
  conditions     TEXT CHECK (conditions IS NULL OR json_valid(conditions)),
  is_active      INTEGER NOT NULL DEFAULT 1,
  valid_from     TEXT,
  valid_until    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE notification_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '{}',
  channels     TEXT NOT NULL DEFAULT '["webhook"]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES notification_rules (id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE outbound_line_deliveries (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  delivery_type      TEXT NOT NULL CHECK (delivery_type IN ('push', 'reply', 'broadcast')),
  outcome            TEXT NOT NULL CHECK (outcome IN ('open', 'accepted', 'retired')),
  retry_key          TEXT UNIQUE,
  request_json       TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  prepare_token      TEXT NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_until        TEXT NOT NULL,
  first_attempted_at TEXT,
  attempted_at       TEXT,
  settled_at         TEXT,
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN (
                       'retry_window_expired', 'reply_outcome_unknown', 'payload_unavailable',
                       'local_precondition_failed', 'reply_rejected'
                     )),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (
    (delivery_type IN ('push', 'broadcast') AND retry_key IS NOT NULL)
    OR (delivery_type = 'reply' AND retry_key IS NULL)
  ),
  CHECK (
    (delivery_type = 'broadcast' AND request_json IS NOT NULL)
    OR (delivery_type IN ('push', 'reply') AND request_json IS NULL)
  ),
  CHECK (
    (outcome = 'open' AND settled_at IS NULL AND stop_reason IS NULL)
    OR (outcome = 'accepted' AND settled_at IS NOT NULL AND stop_reason IS NULL)
    OR (outcome = 'retired' AND settled_at IS NOT NULL AND stop_reason IS NOT NULL)
  ),
  UNIQUE (id, tenant_id, line_account_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE outbound_line_delivery_payloads (
  operation_id   TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  friend_id      TEXT NOT NULL,
  message_type  TEXT NOT NULL,
  log_content   TEXT NOT NULL,
  log_delivery_type TEXT NOT NULL CHECK (log_delivery_type IN ('push', 'reply', 'test')),
  request_json  TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  broadcast_id  TEXT REFERENCES broadcasts(id) ON DELETE SET NULL,
  scenario_enrollment_id TEXT REFERENCES friend_scenarios(id) ON DELETE SET NULL,
  scenario_step_id       TEXT REFERENCES scenario_steps(id) ON DELETE SET NULL,
  scenario_claim_token   TEXT,
  template_id_at_send    TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (operation_id, tenant_id, line_account_id)
    REFERENCES outbound_line_deliveries(id, tenant_id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE outgoing_webhook_deliveries (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT,
  target_type     TEXT NOT NULL CHECK (target_type IN ('configured', 'automation')),
  target_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('attempted', 'sent', 'failed')),
  claim_token     TEXT,
  attempt_count   INTEGER NOT NULL CHECK (attempt_count >= 1),
  http_status     INTEGER CHECK (http_status BETWEEN 100 AND 599),
  attempted_at    TEXT NOT NULL,
  settled_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (
    (outcome = 'attempted' AND claim_token IS NOT NULL AND settled_at IS NULL)
    OR
    (outcome IN ('sent', 'failed') AND claim_token IS NULL AND settled_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE outgoing_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT);

CREATE TABLE pharmacy_account_capabilities (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'pharmacy' CHECK (mode = 'pharmacy'),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  proactive_monthly_limit INTEGER NOT NULL DEFAULT 1 CHECK (proactive_monthly_limit >= 0),
  unfollow_alert_state TEXT NOT NULL DEFAULT 'alert_only'
    CHECK (unfollow_alert_state IN ('alert_only','auto_pause')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pharmacy_account_capability_revisions (
  line_account_id TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_account_capabilities(line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_activity_notifications (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  activity_type     TEXT NOT NULL CHECK (activity_type IN
    ('prescription_received', 'prescription_status_changed',
     'fulfillment_quote_created', 'myna_handoff_received')),
  dedupe_hash       TEXT NOT NULL
    CHECK (length(dedupe_hash) = 64 AND dedupe_hash NOT GLOB '*[^0-9a-f]*'),
  acknowledged_by  TEXT,
  acknowledged_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK ((acknowledged_by IS NULL AND acknowledged_at IS NULL)
      OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)),
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, dedupe_hash),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE pharmacy_cli_break_glass_sessions (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE
                    REFERENCES tenant_admin_sessions(token_hash) ON DELETE RESTRICT,
  platform_admin_id TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id         TEXT NOT NULL,
  staff_id          TEXT NOT NULL,
  operation_scope   TEXT NOT NULL CHECK (operation_scope = 'all'),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  ticket_reference  TEXT CHECK (
                    ticket_reference IS NULL OR length(ticket_reference) BETWEEN 1 AND 120),
  issued_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revoked_by        TEXT REFERENCES platform_admins(staff_id),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships(tenant_id, staff_id),
  CHECK (
    unixepoch(issued_at) IS NOT NULL AND unixepoch(expires_at) IS NOT NULL AND
    unixepoch(expires_at) - unixepoch(issued_at) BETWEEN 1 AND 7200
  ),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE TABLE pharmacy_continuity_events (
  id              TEXT PRIMARY KEY,
  obligation_id   TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN
    ('opened','linked','reminded','fulfilled','paused','ended')),
  submission_id   TEXT,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('staff','system','patient')),
  actor_id        TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (obligation_id, line_account_id)
    REFERENCES pharmacy_continuity_obligations(id, line_account_id)
);

CREATE TABLE pharmacy_continuity_obligations (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  owner_friend_id       TEXT NOT NULL,
  patient_id            TEXT NOT NULL,
  source_submission_id  TEXT NOT NULL,
  candidate_submission_id TEXT,
  status                TEXT NOT NULL CHECK (status IN
    ('active','linked','fulfilled','paused','ended')),
  expected_next_from    TEXT NOT NULL,
  expected_next_to      TEXT NOT NULL,
  next_contact_at       TEXT NOT NULL,
  consent_at            TEXT NOT NULL,
  last_reminded_at      TEXT,
  reminder_count        INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id, owner_friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (source_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id),
  FOREIGN KEY (candidate_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id)
);

CREATE TABLE pharmacy_data_subject_request_events (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('received', 'identity_verified', 'legal_hold_assessed',
                          'resolved', 'rejected')),
  actor_staff_id  TEXT NOT NULL,
  detail          TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
  occurred_at     TEXT NOT NULL,
  UNIQUE (line_account_id, request_id, event_type),
  FOREIGN KEY (request_id, line_account_id)
    REFERENCES pharmacy_data_subject_requests(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, actor_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_data_subject_requests (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  line_account_id        TEXT NOT NULL,
  owner_friend_id        TEXT NOT NULL,
  patient_id             TEXT NOT NULL,
  request_type           TEXT NOT NULL
    CHECK (request_type IN ('access', 'correction', 'suspension', 'erasure')),
  status                 TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'identity_verified', 'legal_hold_assessed',
                      'resolved', 'rejected')),
  reason                 TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  legal_hold             INTEGER CHECK (legal_hold IS NULL OR legal_hold IN (0, 1)),
  legal_hold_basis       TEXT CHECK (legal_hold_basis IS NULL OR
                                     legal_hold_basis = 'pharmacist_law_enforcement_regulation_3y'),
  legal_hold_release_at  TEXT,
  outcome_note           TEXT CHECK (outcome_note IS NULL OR length(outcome_note) <= 2000),
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at           TEXT NOT NULL,
  identity_verified_at   TEXT,
  legal_hold_assessed_at TEXT,
  resolved_at            TEXT,
  resolved_by            TEXT,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  -- 本人確認前に法定保存判定へ進めない / 判定前に結果を確定できない。
  CHECK (status <> 'identity_verified' OR identity_verified_at IS NOT NULL),
  CHECK (status <> 'legal_hold_assessed' OR
         (identity_verified_at IS NOT NULL AND legal_hold IS NOT NULL AND
          legal_hold_assessed_at IS NOT NULL)),
  CHECK (status NOT IN ('resolved', 'rejected') OR
         (legal_hold IS NOT NULL AND resolved_at IS NOT NULL AND
          resolved_by IS NOT NULL AND outcome_note IS NOT NULL)),
  -- 法定保存期間中は消去・利用停止に応じられない。応じられない旨を記録して
  -- 'rejected' で閉じるしかない構造にする(アプリ側の判断に依存させない)。
  CHECK (status <> 'resolved' OR legal_hold = 0 OR
         request_type IN ('access', 'correction')),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (line_account_id, created_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, resolved_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_admin_events (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type = 'inventory_updated'),
  aggregate_id      TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
  on_hand           INTEGER NOT NULL CHECK (on_hand >= 0),
  occurred_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id, actor_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_counter_confirmations (
  line_account_id      TEXT NOT NULL,
  intake_id             TEXT NOT NULL,
  section                TEXT NOT NULL CHECK (section IN ('A', 'B', 'C', 'D')),
  checklist_version     TEXT NOT NULL,
  mismatch_items_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mismatch_items_json)),
  staff_id                TEXT NOT NULL,
  confirmed_at           TEXT NOT NULL,
  PRIMARY KEY (line_account_id, intake_id, section),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id),
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_intake_access_events (
  id              TEXT PRIMARY KEY,
  intake_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  accessed_at     TEXT NOT NULL,
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_intake_events (
  id              TEXT PRIMARY KEY,
  intake_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('created', 'reviewed', 'completed', 'cancelled', 'expired')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('patient', 'staff', 'system')),
  actor_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at     TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_emergency_intakes (
  id                  TEXT PRIMARY KEY,
  reference_code      TEXT NOT NULL UNIQUE CHECK (length(reference_code) BETWEEN 12 AND 64),
  tenant_id           TEXT NOT NULL,
  line_account_id     TEXT NOT NULL,
  owner_friend_id     TEXT NOT NULL,
  slot_id             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'provisional'
    CHECK (status IN ('provisional', 'reviewed', 'completed', 'cancelled', 'expired')),
  encrypted_payload   TEXT NOT NULL,
  payload_key_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_key_version >= 1),
  age_band            TEXT NOT NULL CHECK (age_band IN ('under_16', '16_17', 'adult')),
  safe_contact_mode   TEXT NOT NULL
    CHECK (safe_contact_mode IN ('neutral_line', 'no_notification', 'phone', 'none')),
  consent_version     TEXT NOT NULL,
  risk_flags_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags_json)),
  -- Product the hold was taken against, captured from pharmacy_emergency_settings
  -- at creation time. An account may stock several products at once, and settings
  -- only point at the currently active one, so completion must not re-resolve it.
  product_code        TEXT,
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  expires_at          TEXT NOT NULL,
  reviewed_by         TEXT,
  reviewed_at         TEXT,
  closed_by           TEXT,
  closed_at           TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (slot_id, line_account_id)
    REFERENCES pharmacy_emergency_slots(id, line_account_id),
  FOREIGN KEY (line_account_id, reviewed_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, closed_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_inventory (
  line_account_id TEXT NOT NULL,
  product_code    TEXT NOT NULL,
  on_hand         INTEGER NOT NULL CHECK (on_hand >= 0),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, product_code),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_pharmacists (
  line_account_id              TEXT NOT NULL,
  staff_id                     TEXT NOT NULL,
  training_registration_number TEXT NOT NULL,
  is_active                    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  PRIMARY KEY (line_account_id, staff_id),
  FOREIGN KEY (line_account_id, staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_emergency_reminder_controls (
  line_account_id  TEXT PRIMARY KEY,
  state            TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'frozen')),
  time_zone        TEXT NOT NULL DEFAULT 'Asia/Tokyo' CHECK (time_zone = 'Asia/Tokyo'),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  updated_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_reminders (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  intake_id        TEXT NOT NULL,
  reminder_kind    TEXT NOT NULL CHECK (reminder_kind = 'appointment_neutral_v1'),
  anchor_at        TEXT NOT NULL,
  due_at           TEXT NOT NULL,
  deadline_at      TEXT NOT NULL,
  occurrence_hash  TEXT NOT NULL
    CHECK (length(occurrence_hash) = 64 AND occurrence_hash NOT GLOB '*[^0-9a-f]*'),
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'suppressed', 'failed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token      TEXT,
  claimed_at       TEXT,
  reason_code      TEXT CHECK (reason_code IS NULL OR reason_code IN (
                     'QUIET_HOURS_PAST_DEADLINE', 'ACTIVATION_DISABLED',
                     'FEATURE_DISABLED', 'CONTACT_NOT_ALLOWED', 'INTAKE_INACTIVE',
                     'INTAKE_EXPIRED', 'ANCHOR_CHANGED', 'DEADLINE_PASSED',
                     'RECIPIENT_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'SEND_FAILED'
                   )),
  sent_at          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (line_account_id, intake_id, reminder_kind, anchor_at),
  UNIQUE (line_account_id, occurrence_hash),
  CHECK (deadline_at > due_at),
  CHECK ((status = 'processing') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_emergency_retention_purge_log (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  resource_type     TEXT NOT NULL
    CHECK (resource_type IN ('emergency_intake')),
  resource_id       TEXT NOT NULL,
  -- The intake's created_at, copied verbatim, so an audit can confirm the
  -- row was actually past the account's own retention_days boundary.
  age_reference_at  TEXT NOT NULL,
  retention_days    INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
  purged_at         TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE TABLE pharmacy_emergency_sale_records (
  id                            TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL,
  intake_id                     TEXT NOT NULL,
  -- Kept alongside intake_id (not resolved via join) so the legal-hold query
  -- against pharmacy_data_subject_requests(line_account_id, owner_friend_id)
  -- stays a plain equality lookup even if the intake row is later redacted.
  owner_friend_id               TEXT NOT NULL,
  product_code                  TEXT NOT NULL,
  checklist_version             TEXT NOT NULL,
  quantity                       INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
  outcome                        TEXT NOT NULL CHECK (outcome IN ('sold', 'refused')),
  identity_check                 TEXT NOT NULL
    CHECK (identity_check IN ('document', 'verbal', 'unverified')),
  in_person_dose                 TEXT NOT NULL CHECK (in_person_dose IN ('done', 'not_done')),
  checklist_sheets_received     INTEGER NOT NULL DEFAULT 0 CHECK (checklist_sheets_received >= 0),
  pharmacist_staff_id            TEXT NOT NULL,
  -- Copied from pharmacy_emergency_pharmacists at sale time, same reasoning
  -- as custom_035's intake.product_code snapshot: the statutory record must
  -- keep pointing at the registration that was actually live at sale time.
  training_registration_number  TEXT NOT NULL,
  determination_encrypted        TEXT NOT NULL,
  determination_key_version      INTEGER NOT NULL DEFAULT 1 CHECK (determination_key_version >= 1),
  sold_at                         TEXT NOT NULL,
  created_at                      TEXT NOT NULL,
  UNIQUE (line_account_id, intake_id),
  FOREIGN KEY (intake_id, line_account_id)
    REFERENCES pharmacy_emergency_intakes(id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (line_account_id, pharmacist_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_settings (
  line_account_id              TEXT PRIMARY KEY,
  is_enabled                   INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  pharmacy_registration_number TEXT NOT NULL,
  product_code                 TEXT NOT NULL,
  manufacturer_check_url       TEXT NOT NULL,
  privacy_policy_url           TEXT NOT NULL,
  privacy_contact              TEXT NOT NULL,
  purpose_text                 TEXT NOT NULL,
  consent_version              TEXT NOT NULL,
  retention_days               INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
  consultation_minutes         INTEGER NOT NULL CHECK (consultation_minutes BETWEEN 1 AND 180),
  reservation_ttl_minutes      INTEGER NOT NULL CHECK (reservation_ttl_minutes BETWEEN 5 AND 1440),
  privacy_space_ready          INTEGER NOT NULL DEFAULT 0 CHECK (privacy_space_ready IN (0, 1)),
  drinking_water_ready         INTEGER NOT NULL DEFAULT 0 CHECK (drinking_water_ready IN (0, 1)),
  partner_clinic_url           TEXT NOT NULL,
  support_center_url           TEXT NOT NULL,
  updated_by                   TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_emergency_slots (
  id                  TEXT PRIMARY KEY,
  line_account_id     TEXT NOT NULL,
  pharmacist_staff_id TEXT NOT NULL,
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'cancelled')),
  capacity            INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 20),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, pharmacist_staff_id, starts_at),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (line_account_id, pharmacist_staff_id)
    REFERENCES pharmacy_emergency_pharmacists(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, created_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_fulfillment_quotes (
  id                    TEXT PRIMARY KEY,
  submission_id         TEXT NOT NULL,
  line_account_id       TEXT NOT NULL,
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  decision              TEXT NOT NULL CHECK (decision IN
    ('fulfillable','conditional','needs_confirmation','not_fulfillable')),
  reason_codes_json     TEXT NOT NULL
    CHECK (json_valid(reason_codes_json) AND length(reason_codes_json) BETWEEN 2 AND 4096),
  requirements_json     TEXT NOT NULL
    CHECK (json_valid(requirements_json) AND length(requirements_json) BETWEEN 2 AND 8192),
  estimated_ready_at    TEXT,
  valid_until           TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL, status TEXT CHECK (status IS NULL OR status IN
    ('CHECKING','AVAILABLE','PARTIALLY_AVAILABLE','UNAVAILABLE','PHARMACIST_REVIEW_REQUIRED')), fulfillment_method TEXT CHECK (fulfillment_method IS NULL OR fulfillment_method IN
    ('PICKUP','DELIVERY','HOME_VISIT','FACILITY_DELIVERY')), constraints_json TEXT CHECK (constraints_json IS NULL OR
    (json_valid(constraints_json) AND length(constraints_json) BETWEEN 2 AND 4096)), reservation_expires_at TEXT, confirmed_by TEXT, confirmed_at TEXT,
  UNIQUE (submission_id, line_account_id, revision),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE TABLE pharmacy_growth_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  subject_key TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE pharmacy_incoming_image_dispositions (
  r2_key          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  stored_at       TEXT,
  stored_sha256   TEXT CHECK (stored_sha256 IS NULL OR length(stored_sha256) = 64),
  status          TEXT NOT NULL CHECK (status IN (
    'TRACKED', 'CLAIMED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE',
    'DELETE_COMMITTED', 'FINALIZED_DELETED', 'OUTCOME_UNKNOWN',
    'ORPHAN', 'MISSING', 'OWNERSHIP_MISMATCH', 'UNKNOWN', 'BLOCKED'
  )),
  source          TEXT NOT NULL CHECK (source IN ('tracked_row', 'messages_log', 'r2_inventory', 'reconcile')),
  reason_code     TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 120),
  hold_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (hold_epoch >= 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  UNIQUE (tenant_id, line_account_id, message_id, r2_key)
);

CREATE TABLE pharmacy_incoming_image_objects (
  r2_key          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  stored_at       TEXT NOT NULL
);

CREATE TABLE pharmacy_line_channel_identities (
  line_account_id TEXT PRIMARY KEY,
  bot_user_id     TEXT NOT NULL UNIQUE CHECK (length(bot_user_id) BETWEEN 2 AND 128),
  created_at      TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts (id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_line_credentials (
  tenant_id       TEXT NOT NULL CHECK (length(tenant_id) > 0),
  line_account_id TEXT NOT NULL CHECK (length(line_account_id) > 0),
  credential_kind TEXT NOT NULL CHECK (
    credential_kind IN ('channel_access_token', 'channel_secret', 'login_channel_secret')
  ),
  nonce           TEXT NOT NULL CHECK (length(nonce) > 0),
  ciphertext      TEXT NOT NULL CHECK (length(ciphertext) > 0),
  key_version     INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lookup_digest   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, line_account_id, credential_kind),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id) ON DELETE CASCADE,
  CHECK (
    (credential_kind = 'channel_access_token' AND
     lookup_digest IS NOT NULL AND
     length(lookup_digest) = 64 AND
     lookup_digest NOT GLOB '*[^0-9a-f]*')
    OR
    (credential_kind <> 'channel_access_token' AND lookup_digest IS NULL)
  )
);

CREATE TABLE pharmacy_medical_sources (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  classification TEXT NOT NULL CHECK (classification IN ('primary','other')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (line_account_id, display_name)
);

CREATE TABLE pharmacy_medication_followup_events (
  id               TEXT PRIMARY KEY,
  followup_id      TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL
    CHECK (event_type IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  from_status      TEXT
    CHECK (from_status IS NULL OR from_status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  to_status        TEXT
    CHECK (to_status IS NULL OR to_status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id         TEXT,
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at      TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (followup_id, line_account_id)
    REFERENCES pharmacy_medication_followups(id, line_account_id)
);

CREATE TABLE pharmacy_medication_followups (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  owner_friend_id       TEXT NOT NULL,
  patient_id            TEXT NOT NULL,
  source_submission_id  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN
      ('scheduled','due','delivered','no_issue','concern','pharmacist_requested',
       'assigned','responded','escalated','closed','cancelled')),
  due_at                TEXT NOT NULL,
  delivered_at          TEXT,
  responded_at          TEXT,
  assigned_to           TEXT,
  closed_at             TEXT,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, source_submission_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (source_submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_patients(submission_id, line_account_id, owner_friend_id)
);

CREATE TABLE pharmacy_myna_endpoint_configs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id),
  tenant_alias          TEXT NOT NULL UNIQUE CHECK (
    length(tenant_alias) BETWEEN 3 AND 64
    AND tenant_alias NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  endpoint_url_encrypted TEXT NOT NULL,
  endpoint_url_hash     TEXT NOT NULL,
  allowed_host          TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  valid_from            TEXT NOT NULL,
  retired_at            TEXT,
  last_verified_at      TEXT,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by            TEXT NOT NULL,
  updated_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id)
);

CREATE TABLE pharmacy_myna_events (
  id              TEXT PRIMARY KEY,
  handoff_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN
    ('PRESCRIPTION_INTENT_CREATED','MYNA_EXTERNAL_LAUNCH_REQUESTED',
     'MYNA_PATIENT_REPORTED_COMPLETE','MYNA_PATIENT_REPORTED_NO_PRESCRIPTION',
     'MYNA_SUPPORT_REQUESTED','MYNA_VERIFICATION_RECORDED',
     'E_PRESCRIPTION_RECEIPT_CONFIRMED','PRESCRIPTION_RECEIPT_REJECTED',
     'FULFILLMENT_REVIEW_STARTED','FULFILLMENT_QUOTE_ISSUED')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('PATIENT_CONTACT','STAFF','SYSTEM')),
  actor_id        TEXT,
  correlation_id  TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  metadata_json   TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND length(metadata_json) BETWEEN 2 AND 4096),
  occurred_at     TEXT NOT NULL,
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id)
);

CREATE TABLE pharmacy_myna_handoffs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  patient_id            TEXT,
  expectation_id        TEXT,
  method                TEXT NOT NULL CHECK
    (method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT')),
  status                TEXT NOT NULL CHECK (status IN
    ('CREATED','LAUNCH_REQUESTED','PATIENT_REPORTED_COMPLETE',
     'PATIENT_REPORTED_NO_PRESCRIPTION','SUPPORT_NEEDED','PAPER_FALLBACK',
     'ABANDONED','EXPIRED','CLOSED')),
  source                TEXT NOT NULL CHECK (source IN ('RICH_MENU','MESSAGE','LIFF')),
  correlation_id        TEXT NOT NULL,
  launched_at           TEXT,
  patient_reported_at   TEXT,
  expires_at            TEXT NOT NULL,
  closed_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, friend_id, correlation_id),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE TABLE pharmacy_myna_verifications (
  id                TEXT PRIMARY KEY,
  handoff_id        TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
    ('NOT_CHECKED','E_PRESCRIPTION_RECEIVED','CONSENT_ONLY_OR_NO_PRESCRIPTION',
     'NO_RECORD_FOUND','SUBMITTED_TO_OTHER_PHARMACY','PRESCRIPTION_EXPIRED',
     'PAPER_FALLBACK','PATIENT_MISMATCH','MANUAL_EXCEPTION')),
  verified_by       TEXT NOT NULL,
  verified_at       TEXT NOT NULL,
  reason_code       TEXT,
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  source_system     TEXT NOT NULL,
  source_reference  TEXT CHECK (source_reference IS NULL OR length(source_reference) BETWEEN 1 AND 128),
  created_at        TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id)
);

CREATE TABLE pharmacy_next_intake_expectation_events (
  id               TEXT PRIMARY KEY,
  expectation_id   TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  event_type       TEXT NOT NULL
    CHECK (event_type IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  from_status      TEXT
    CHECK (from_status IS NULL OR from_status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  to_status        TEXT
    CHECK (to_status IS NULL OR to_status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id         TEXT,
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at      TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (expectation_id, line_account_id)
    REFERENCES pharmacy_next_intake_expectations(id, line_account_id)
);

CREATE TABLE pharmacy_next_intake_expectations (
  id                 TEXT PRIMARY KEY,
  obligation_id      TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  owner_friend_id    TEXT NOT NULL,
  patient_id         TEXT NOT NULL,
  status             TEXT NOT NULL
    CHECK (status IN
      ('offered','accepted','active','reminded','linked','fulfilled','paused','ended')),
  timing_source      TEXT NOT NULL
    CHECK (timing_source IN ('manual_supply_days','manual_window')),
  supply_days        INTEGER,
  expected_from      TEXT NOT NULL,
  expected_to        TEXT NOT NULL,
  reminder_at        TEXT NOT NULL,
  reminded_at        TEXT,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (obligation_id),
  UNIQUE (id, line_account_id),
  CHECK (expected_to >= expected_from),
  CHECK (
    (timing_source = 'manual_supply_days' AND supply_days BETWEEN 1 AND 365) OR
    (timing_source = 'manual_window' AND supply_days IS NULL)
  ),
  FOREIGN KEY (obligation_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_continuity_obligations(id, line_account_id, owner_friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE TABLE pharmacy_notification_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('transactional_care','followup_care','continuity','proactive_noncare','manual')),
  outcome TEXT NOT NULL CHECK (outcome IN ('attempted','sent','blocked','failed')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_patient_intake_envelopes (
  response_id       TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,
  owner_friend_id   TEXT NOT NULL,
  patient_id        TEXT NOT NULL,
  field_name        TEXT NOT NULL
    CHECK (field_name IN ('patient_snapshot_json', 'answers_json')),
  schema_version    INTEGER NOT NULL CHECK (schema_version >= 1),
  source_revision   INTEGER NOT NULL CHECK (source_revision >= 1),
  envelope_version  INTEGER NOT NULL CHECK (envelope_version >= 1),
  key_version       INTEGER NOT NULL CHECK (key_version >= 1),
  nonce             TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext        TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 22 AND 90000),
  encrypted_at      TEXT NOT NULL CHECK (length(encrypted_at) >= 20),
  PRIMARY KEY (response_id, field_name),
  UNIQUE (key_version, nonce),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (
    response_id, patient_id, line_account_id, owner_friend_id, schema_version, source_revision
  ) REFERENCES pharmacy_patient_intake_responses (
    id, patient_id, line_account_id, owner_friend_id, schema_version, revision
  ) ON DELETE CASCADE
);

CREATE TABLE pharmacy_patient_intake_migration_state (
  tenant_id          TEXT NOT NULL,
  line_account_id    TEXT PRIMARY KEY,
  phase              TEXT NOT NULL
    CHECK (phase IN ('frozen', 'scrubbing', 'scrubbed', 'restoring', 'restored')),
  coverage_total     INTEGER NOT NULL CHECK (coverage_total >= 0),
  coverage_digest    TEXT NOT NULL CHECK (
    length(coverage_digest) = 64 AND coverage_digest NOT GLOB '*[^0-9a-f]*'
  ),
  approved_by        TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 120),
  approval_reference TEXT NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 240),
  approved_at        TEXT NOT NULL CHECK (length(approved_at) >= 20),
  updated_at         TEXT NOT NULL CHECK (length(updated_at) >= 20),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE TABLE pharmacy_patient_intake_responses (
  id                          TEXT PRIMARY KEY,
  line_account_id             TEXT NOT NULL,
  owner_friend_id             TEXT NOT NULL,
  patient_id                  TEXT NOT NULL,
  revision                    INTEGER NOT NULL CHECK (revision >= 1),
  schema_version              INTEGER NOT NULL CHECK (schema_version >= 1),
  patient_snapshot_json       TEXT NOT NULL CHECK (json_valid(patient_snapshot_json)),
  answers_json                TEXT NOT NULL
    CHECK (json_valid(answers_json) AND length(answers_json) BETWEEN 2 AND 32768),
  base_response_id            TEXT,
  idempotency_key             TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  representative_consent_at  TEXT NOT NULL,
  privacy_consent_at          TEXT NOT NULL,
  created_at                  TEXT NOT NULL, privacy_policy_version INTEGER, privacy_policy_hash TEXT,
  UNIQUE (id, patient_id, line_account_id, owner_friend_id),
  UNIQUE (line_account_id, patient_id, revision),
  UNIQUE (line_account_id, owner_friend_id, patient_id, idempotency_key),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (base_response_id)
    REFERENCES pharmacy_patient_intake_responses(id)
);

CREATE TABLE pharmacy_patients (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id),
  owner_friend_id  TEXT NOT NULL,
  relationship     TEXT NOT NULL CHECK (relationship IN ('self','child','spouse','parent','other')),
  name             TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  name_kana        TEXT NOT NULL CHECK (length(trim(name_kana)) BETWEEN 1 AND 120),
  birth_date       TEXT NOT NULL CHECK (length(birth_date) = 10),
  sex              TEXT CHECK (sex IS NULL OR sex IN ('male','female','other','prefer_not_to_say')),
  contact_phone    TEXT,
  archived_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL, postal_code TEXT, prefecture TEXT, city TEXT, address_line1 TEXT, address_line2 TEXT,
  UNIQUE (id, line_account_id, owner_friend_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id)
);

CREATE TABLE pharmacy_phi_retention_purge_log (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT,
  line_account_id   TEXT,
  resource_type     TEXT NOT NULL
    CHECK (resource_type IN ('prescription_file')),
  resource_id       TEXT NOT NULL,
  r2_key            TEXT,
  -- The timestamp the 3-year boundary was measured against, copied verbatim
  -- from the purged row. Without it the log cannot prove the row was actually
  -- past retention rather than deleted early.
  age_reference_at  TEXT NOT NULL,
  retention_years   INTEGER NOT NULL CHECK (retention_years >= 1),
  purged_at         TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE TABLE pharmacy_prescription_events (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('patient','staff','system')),
  actor_id       TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN
    ('status_changed','revision_reserved','revision_activated','file_deleted',
     'notification_failed','notification_sent')),
  from_status    TEXT CHECK (from_status IS NULL OR from_status IN
    ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  to_status      TEXT CHECK (to_status IS NULL OR to_status IN
    ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  reason_code    TEXT CHECK (reason_code IS NULL OR reason_code IN
    ('blurred','cropped','glare','unreadable','missing_page','patient_cancelled','admin_cancelled')),
  revision       INTEGER CHECK (revision IS NULL OR revision >= 1),
  created_at     TEXT NOT NULL
);

CREATE TABLE pharmacy_prescription_expectations (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  patient_id            TEXT,
  handoff_id            TEXT NOT NULL,
  method                TEXT NOT NULL CHECK
    (method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT')),
  receipt_status        TEXT NOT NULL CHECK (receipt_status IN
    ('EXPECTED','RECEIPT_REPORTED','RECEIVED','FULFILLMENT_REVIEW','ACCEPTED',
     'DISPENSING','READY','DELIVERED','CANCELLED','EXPIRED')),
  shadow_submission_id  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  UNIQUE (handoff_id),
  FOREIGN KEY (handoff_id, line_account_id)
    REFERENCES pharmacy_myna_handoffs(id, line_account_id),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (shadow_submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE TABLE pharmacy_prescription_files (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  position       INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  r2_key         TEXT NOT NULL UNIQUE
    CHECK (r2_key LIKE 'custom/pharmacy/prescriptions/%'),
  content_type   TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  byte_size      INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
  state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','ready','deleted')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (submission_id, revision, position)
);

CREATE TABLE pharmacy_prescription_patients (
  submission_id      TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  owner_friend_id    TEXT NOT NULL,
  patient_id         TEXT NOT NULL,
  intake_response_id TEXT NOT NULL,
  reviewed_at        TEXT,
  reviewed_by        TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (submission_id, line_account_id, owner_friend_id),
  FOREIGN KEY (submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (intake_response_id, patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patient_intake_responses(id, patient_id, line_account_id, owner_friend_id)
);

CREATE TABLE pharmacy_prescription_submissions (
  id                               TEXT PRIMARY KEY,
  line_account_id                  TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id                        TEXT NOT NULL,
  idempotency_key                  TEXT NOT NULL,
  status                           TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','received','needs_resubmission','accepted','ready','closed','cancelled')),
  active_revision                  INTEGER CHECK (active_revision >= 1),
  upload_revision                  INTEGER NOT NULL DEFAULT 1 CHECK (upload_revision >= 1),
  desired_pickup_at                TEXT,
  original_prescription_consent_at TEXT,
  readiness_notice_consent_at      TEXT,
  resubmission_reason_code         TEXT
    CHECK (resubmission_reason_code IS NULL OR resubmission_reason_code IN
      ('blurred','cropped','glare','unreadable','missing_page')),
  requested_at                     TEXT,
  closed_at                        TEXT,
  created_at                       TEXT NOT NULL,
  updated_at                       TEXT NOT NULL, intake_required INTEGER NOT NULL DEFAULT 0
  CHECK (intake_required IN (0, 1)), intake_method TEXT NOT NULL DEFAULT 'PAPER' CHECK
    (intake_method IN ('E_PRESCRIPTION','PAPER','MEDICAL_INSTITUTION_SENT')), source_handoff_id TEXT, desired_fulfillment_method TEXT CHECK (
    desired_fulfillment_method IS NULL OR desired_fulfillment_method IN ('PICKUP','DELIVERY')
  ), arrival_reported_at TEXT,
  UNIQUE (line_account_id, friend_id, idempotency_key),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id)
);

CREATE TABLE pharmacy_prescription_validities (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  issued_on TEXT,
  valid_until TEXT,
  validity_basis TEXT NOT NULL CHECK (validity_basis IN ('default_4_days','prescriber_specified')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','expired_review_required','expired_confirmed')),
  verified_by TEXT,
  verified_at TEXT,
  reminder_due_at TEXT,
  reminder_claimed_at TEXT,
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on),
  CHECK (verification_status = 'unverified' OR
    (issued_on IS NOT NULL AND valid_until IS NOT NULL AND
     verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_prescription_view_events (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES pharmacy_prescription_files(id) ON DELETE CASCADE,
  staff_id      TEXT NOT NULL,
  viewed_at     TEXT NOT NULL
);

CREATE TABLE pharmacy_print_tasks (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  submission_id      TEXT NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'handling', 'acknowledged', 'cancelled')),
  handling_by        TEXT,
  handling_token     TEXT CHECK (handling_token IS NULL OR length(handling_token) BETWEEN 8 AND 160),
  handling_at        TEXT,
  lease_until        TEXT,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (
    status IN ('pending', 'cancelled')
    OR (status = 'handling' AND handling_by IS NOT NULL AND handling_token IS NOT NULL
        AND handling_at IS NOT NULL AND lease_until IS NOT NULL)
    OR (status = 'acknowledged' AND handling_by IS NOT NULL AND handling_token IS NOT NULL
        AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, submission_id, revision),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE TABLE pharmacy_public_profiles (
  line_account_id TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  phone           TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  postal_code     TEXT NOT NULL DEFAULT '' CHECK (length(postal_code) <= 16),
  address         TEXT NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 500),
  business_hours  TEXT NOT NULL CHECK (length(trim(business_hours)) BETWEEN 1 AND 2000),
  closure_notice  TEXT NOT NULL DEFAULT '' CHECK (length(closure_notice) <= 1000),
  access_note     TEXT NOT NULL DEFAULT '' CHECK (length(access_note) <= 1000),
  parking_note    TEXT NOT NULL DEFAULT '' CHECK (length(parking_note) <= 1000),
  google_maps_url TEXT NOT NULL DEFAULT '' CHECK (length(google_maps_url) <= 2000),
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL, prescription_reception_hours TEXT NOT NULL DEFAULT '' CHECK (length(prescription_reception_hours) <= 2000), after_hours_note TEXT NOT NULL DEFAULT '' CHECK (length(after_hours_note) <= 1000), services_note TEXT NOT NULL DEFAULT '' CHECK (length(services_note) <= 2000), accessibility_note TEXT NOT NULL DEFAULT '' CHECK (length(accessibility_note) <= 1000), supported_languages TEXT NOT NULL DEFAULT '' CHECK (length(supported_languages) <= 1000), payment_methods TEXT NOT NULL DEFAULT '' CHECK (length(payment_methods) <= 1000), website_url TEXT NOT NULL DEFAULT '' CHECK (length(website_url) <= 2000), fax_number TEXT NOT NULL DEFAULT '' CHECK (length(fax_number) <= 40),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_recovery_backup_generations (
  generation_id          TEXT NOT NULL,
  tenant_id              TEXT NOT NULL,
  line_account_id        TEXT NOT NULL,
  environment            TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  status                 TEXT NOT NULL CHECK (status IN ('verified', 'invalidated')),
  manifest_digest        TEXT NOT NULL CHECK (
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_row_count     INTEGER NOT NULL CHECK (expected_row_count >= 0),
  expected_object_count  INTEGER NOT NULL CHECK (expected_object_count >= 0),
  verified_at            TEXT NOT NULL CHECK (length(verified_at) >= 20),
  created_at             TEXT NOT NULL CHECK (length(created_at) >= 20),
  PRIMARY KEY (generation_id, environment),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE TABLE pharmacy_recovery_execution_fences (
  fence_id             TEXT PRIMARY KEY,
  operation_id         TEXT NOT NULL UNIQUE
                       REFERENCES pharmacy_recovery_operations(id) ON DELETE CASCADE,
  tenant_id            TEXT NOT NULL,
  line_account_id      TEXT NOT NULL,
  environment          TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  execution_id         TEXT NOT NULL UNIQUE,
  fence_token          TEXT NOT NULL UNIQUE CHECK (length(fence_token) BETWEEN 32 AND 240),
  owner_issuer         TEXT NOT NULL CHECK (owner_issuer = 'platform-admin'),
  owner_subject        TEXT NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 160),
  status               TEXT NOT NULL CHECK (status IN ('active', 'released')),
  expires_at           TEXT NOT NULL CHECK (length(expires_at) >= 20),
  created_at           TEXT NOT NULL CHECK (length(created_at) >= 20),
  released_at          TEXT,
  FOREIGN KEY (operation_id, tenant_id, line_account_id, environment)
    REFERENCES pharmacy_recovery_operations(id, tenant_id, line_account_id, environment)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id)
);

CREATE TABLE pharmacy_recovery_operations (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  line_account_id           TEXT NOT NULL,
  environment               TEXT NOT NULL CHECK (
    length(environment) BETWEEN 1 AND 64
    AND environment NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  operation                 TEXT NOT NULL CHECK (
    operation IN (
      'fle_backfill', 'plaintext_scrub', 'plaintext_restore',
      'retention_delete', 'restore_rehearsal'
    )
  ),
  status                    TEXT NOT NULL CHECK (
    status IN ('created', 'preflighted', 'approved', 'running',
               'completed', 'stale', 'failed')
  ),
  requested_by_issuer       TEXT NOT NULL CHECK (requested_by_issuer = 'platform-admin'),
  requested_by_subject      TEXT NOT NULL CHECK (length(requested_by_subject) BETWEEN 1 AND 160),
  approver_issuer           TEXT CHECK (approver_issuer IS NULL OR approver_issuer = 'platform-admin'),
  approver_subject          TEXT CHECK (approver_subject IS NULL OR length(approver_subject) BETWEEN 1 AND 160),
  executor_issuer            TEXT CHECK (executor_issuer IS NULL OR executor_issuer = 'platform-admin'),
  executor_subject          TEXT CHECK (executor_subject IS NULL OR length(executor_subject) BETWEEN 1 AND 160),
  approval_expires_at       TEXT NOT NULL CHECK (length(approval_expires_at) >= 20),
  job_id                    TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 160),
  idempotency_key           TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  schema_digest             TEXT,
  field_inventory_digest    TEXT,
  key_versions_json         TEXT,
  backup_generation_id      TEXT,
  expected_row_count        INTEGER CHECK (expected_row_count IS NULL OR expected_row_count >= 0),
  expected_object_count     INTEGER CHECK (expected_object_count IS NULL OR expected_object_count >= 0),
  stop_policy               TEXT,
  rollback_policy           TEXT,
  evidence_digest           TEXT,
  row_digest                TEXT,
  coverage_total            INTEGER CHECK (coverage_total IS NULL OR coverage_total >= 0),
  coverage_verified         INTEGER CHECK (coverage_verified IS NULL OR coverage_verified IN (0, 1)),
  key_recovery_acknowledged INTEGER CHECK (
    key_recovery_acknowledged IS NULL OR key_recovery_acknowledged IN (0, 1)
  ),
  execution_id              TEXT UNIQUE,
  fence_id                  TEXT UNIQUE,
  fence_token               TEXT UNIQUE,
  cursor                    TEXT,
  processed_row_count       INTEGER NOT NULL DEFAULT 0 CHECK (processed_row_count >= 0),
  processed_object_count    INTEGER NOT NULL DEFAULT 0 CHECK (processed_object_count >= 0),
  last_batch_id             TEXT,
  error_code                TEXT,
  created_at                TEXT NOT NULL CHECK (length(created_at) >= 20),
  approved_at               TEXT,
  claimed_at                TEXT,
  completed_at              TEXT,
  updated_at                TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    executor_subject IS NULL OR approver_subject IS NULL OR executor_subject <> approver_subject
  ),
  UNIQUE (id, tenant_id, line_account_id, environment),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (backup_generation_id, environment)
    REFERENCES pharmacy_recovery_backup_generations(generation_id, environment)
);

CREATE TABLE pharmacy_retention_deletion_intents (
  id              TEXT PRIMARY KEY,
  operation_id    TEXT NOT NULL CHECK (length(trim(operation_id)) BETWEEN 1 AND 200),
  execution_id    TEXT NOT NULL CHECK (length(trim(execution_id)) BETWEEN 1 AND 200),
  fence_token     TEXT NOT NULL CHECK (length(trim(fence_token)) BETWEEN 1 AND 500),
  executor_subject TEXT NOT NULL CHECK (length(trim(executor_subject)) BETWEEN 1 AND 200),
  environment     TEXT NOT NULL CHECK (length(trim(environment)) BETWEEN 1 AND 80),
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  owner_friend_id TEXT NOT NULL,
  patient_key     TEXT NOT NULL CHECK (patient_key = '*' OR length(patient_key) > 0),
  resource_type   TEXT NOT NULL CHECK (resource_type IN ('prescription_file', 'incoming_image')),
  resource_id     TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 300),
  r2_key          TEXT NOT NULL CHECK (length(trim(r2_key)) BETWEEN 1 AND 1000),
  stored_sha256   TEXT NOT NULL CHECK (length(stored_sha256) = 64),
  age_reference_at TEXT NOT NULL,
  row_state       TEXT NOT NULL CHECK (row_state IN ('pending', 'ready', 'deleted')),
  row_revision    INTEGER NOT NULL CHECK (row_revision >= 1),
  hold_epoch      INTEGER NOT NULL CHECK (hold_epoch >= 0),
  status          TEXT NOT NULL CHECK (status IN (
    'CLAIMED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE',
    'DELETE_COMMITTED', 'FINALIZED_DELETED', 'OUTCOME_UNKNOWN'
  )),
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (operation_id, resource_type, resource_id, r2_key, stored_sha256),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends (id, line_account_id)
);

CREATE TABLE pharmacy_retention_hold_epochs (
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  owner_friend_id TEXT NOT NULL,
  patient_key     TEXT NOT NULL CHECK (patient_key = '*' OR length(patient_key) > 0),
  epoch           INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  status          TEXT NOT NULL CHECK (status IN ('held', 'released', 'unknown')),
  release_at      TEXT,
  reason_code     TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, line_account_id, owner_friend_id, patient_key),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends (id, line_account_id)
);

CREATE TABLE pharmacy_rich_menu_draft_bindings (
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

CREATE TABLE pharmacy_rich_menu_layouts (
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

CREATE TABLE pharmacy_rich_menu_lifecycle_controls (
  line_account_id  TEXT PRIMARY KEY,
  state            TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'frozen')),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_account_capabilities(line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_rich_menu_operation_confirmations (
  confirmation_id  TEXT PRIMARY KEY CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  operation_id     TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  publish_phase    TEXT NOT NULL CHECK (publish_phase IN (
                       'intent_recorded', 'remote_created', 'image_uploaded', 'alias_created'
                     )),
  evidence_digest  TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  created_at       TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES pharmacy_rich_menu_operations(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_rich_menu_operations (
  id                        TEXT PRIMARY KEY,
  group_id                  TEXT NOT NULL,
  line_account_id           TEXT NOT NULL,
  confirmation_id           TEXT NOT NULL UNIQUE CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  kind                      TEXT NOT NULL CHECK (kind IN ('publish', 'set_default', 'rollback')),
  status                    TEXT NOT NULL CHECK (status IN ('running', 'unknown', 'succeeded', 'failed')),
  evidence_digest           TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  publish_phase             TEXT CHECK (publish_phase IS NULL OR publish_phase IN (
                                'intent_recorded', 'remote_created', 'image_uploaded',
                                'alias_created', 'committed'
                              )),
  publish_alias_id          TEXT CHECK (publish_alias_id IS NULL OR length(publish_alias_id) BETWEEN 1 AND 100),
  publish_menu_name         TEXT CHECK (publish_menu_name IS NULL OR length(publish_menu_name) BETWEEN 1 AND 300),
  expected_default_menu_id  TEXT CHECK (expected_default_menu_id IS NULL OR length(expected_default_menu_id) > 0),
  default_read_at           TEXT,
  remote_rich_menu_id       TEXT CHECK (remote_rich_menu_id IS NULL OR length(remote_rich_menu_id) > 0),
  verified_default_menu_id  TEXT CHECK (verified_default_menu_id IS NULL OR length(verified_default_menu_id) > 0),
  reason_code               TEXT CHECK (reason_code IS NULL OR length(reason_code) > 0),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  verified_at               TEXT,
  FOREIGN KEY (group_id) REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  CHECK (
    (kind = 'publish' AND publish_phase IS NOT NULL
      AND publish_alias_id IS NOT NULL AND publish_menu_name IS NOT NULL)
    OR
    (kind <> 'publish' AND publish_phase IS NULL
      AND publish_alias_id IS NULL AND publish_menu_name IS NULL)
  )
);

CREATE TABLE pharmacy_staff_accounts (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (line_account_id, staff_id),
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_submission_attributes (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE pharmacy_submission_sources (
  submission_id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_id TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('primary','other','unknown')),
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, line_account_id)
    REFERENCES pharmacy_medical_sources(id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE pharmacy_tenant_admin_bootstraps (
  tenant_id  TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE RESTRICT
);

CREATE TABLE pharmacy_tenant_privacy_policy (
  line_account_id  TEXT PRIMARY KEY,
  purpose_text     TEXT NOT NULL CHECK (length(trim(purpose_text)) BETWEEN 1 AND 4000),
  purpose_url      TEXT NOT NULL DEFAULT '' CHECK (length(purpose_url) <= 2000),
  contact_point    TEXT NOT NULL CHECK (length(trim(contact_point)) BETWEEN 1 AND 1000),
  entrustment_text TEXT NOT NULL CHECK (length(trim(entrustment_text)) BETWEEN 1 AND 2000),
  policy_version   INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  content_hash     TEXT NOT NULL CHECK (length(content_hash) = 64),
  updated_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, updated_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE TABLE pharmacy_tenant_provisioning_requests (
  idempotency_key_hash TEXT PRIMARY KEY
                       CHECK (length(idempotency_key_hash) = 64
                              AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash         TEXT NOT NULL,
  actor_key_hash       TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  line_account_id      TEXT NOT NULL,
  staff_id             TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE RESTRICT
);

CREATE TABLE pharmacy_webhook_event_receipts (
  tenant_id        TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  webhook_event_id TEXT NOT NULL,
  received_at      TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')), lease_until TEXT, retry_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT, claim_token TEXT,
  PRIMARY KEY (tenant_id, line_account_id, webhook_event_id),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE platform_admin_access_events (
  id                TEXT PRIMARY KEY,
  platform_admin_id TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id         TEXT REFERENCES tenants(id),
  action            TEXT NOT NULL,
  resource_type     TEXT,
  resource_id       TEXT,
  detail_json       TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE platform_admin_access_grants (
  id                 TEXT PRIMARY KEY,
  platform_admin_id  TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  scopes             TEXT NOT NULL,       -- JSON array, e.g. ["phi:read"]
  reason             TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  ticket_reference   TEXT,
  reauth_verified_at TEXT NOT NULL,       -- step-up: current password re-checked at grant issue time
  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoked_by         TEXT
, session_token_hash TEXT NOT NULL);

CREATE TABLE platform_admin_credentials (
  staff_id             TEXT PRIMARY KEY
                        REFERENCES platform_admins(staff_id) ON DELETE CASCADE,
  login_id             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1
                        CHECK (must_change_password IN (0, 1)),
  credential_version   INTEGER NOT NULL DEFAULT 1
                        CHECK (credential_version >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE platform_admin_sessions (
  token_hash         TEXT PRIMARY KEY
                      CHECK (length(token_hash) = 64
                             AND token_hash NOT GLOB '*[^0-9a-f]*'),
  session_family_hash TEXT
                      CHECK (session_family_hash IS NULL OR
                             (length(session_family_hash) = 64
                              AND session_family_hash NOT GLOB '*[^0-9a-f]*')),
  staff_id           TEXT NOT NULL
                      REFERENCES platform_admins(staff_id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  session_kind       TEXT NOT NULL CHECK (session_kind IN ('bootstrap', 'standard')),
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL
, last_seen_at TEXT
  CHECK (last_seen_at IS NULL OR unixepoch(last_seen_at) IS NOT NULL));

CREATE TABLE platform_admins (
  staff_id   TEXT PRIMARY KEY REFERENCES staff_members(id) ON DELETE CASCADE,
  granted_by TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pool_id, line_account_id)
);

CREATE TABLE ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, fbclid TEXT, gclid TEXT, twclid TEXT, ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, user_agent TEXT, ip_address TEXT);

CREATE TABLE reminder_steps (
  id              TEXT PRIMARY KEY,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE rich_menu_areas (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES rich_menu_pages(id) ON DELETE CASCADE,
  bounds_x        INTEGER NOT NULL,
  bounds_y        INTEGER NOT NULL,
  bounds_width    INTEGER NOT NULL,
  bounds_height   INTEGER NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('uri','message','postback','richmenuswitch')),
  action_data     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_groups (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  chat_bar_text      TEXT NOT NULL,
  size               TEXT NOT NULL CHECK (size IN ('large','compact')),
  default_page_id    TEXT,
  is_default_for_all INTEGER NOT NULL DEFAULT 0,
  selected           INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publishing_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, generator_key TEXT, generator_version TEXT);

CREATE TABLE rich_menu_pages (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  order_index        INTEGER NOT NULL,
  name               TEXT NOT NULL,
  alias_id           TEXT NOT NULL,
  line_richmenu_id   TEXT,
  image_r2_key       TEXT,
  image_content_type TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (group_id, order_index)
);

CREATE TABLE scenario_steps (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  offset_days     INTEGER,
  offset_minutes  INTEGER,
  delivery_time   TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), condition_type TEXT, condition_value TEXT, next_step_on_false INTEGER,
  UNIQUE (scenario_id, step_order)
);

CREATE TABLE scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  delivery_mode   TEXT NOT NULL DEFAULT 'relative' CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT, tenant_id TEXT);

CREATE TABLE scoring_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE staff (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL,
  name                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  role                     TEXT,
  profile_image_url        TEXT,
  bio                      TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_designation_optional  INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE staff_availability_rules (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, weekday),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE staff_members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, api_key_hash TEXT);

CREATE TABLE staff_menus (
  staff_id                  TEXT NOT NULL,
  menu_id                   TEXT NOT NULL,
  is_offered                INTEGER NOT NULL DEFAULT 1,
  override_duration_minutes INTEGER,
  override_price            INTEGER,
  PRIMARY KEY (staff_id, menu_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE staff_shifts (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  work_date   TEXT NOT NULL,    -- YYYY-MM-DD (JST)
  start_time  TEXT NOT NULL,    -- HH:MM (JST)
  end_time    TEXT NOT NULL,    -- HH:MM (JST)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, work_date),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,
  stripe_event_id  TEXT NOT NULL UNIQUE,
  event_type       TEXT NOT NULL,
  friend_id        TEXT REFERENCES friends (id) ON DELETE SET NULL,
  amount           REAL,
  currency         TEXT,
  metadata         TEXT,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE tags (
  id                          TEXT PRIMARY KEY,
  name                        TEXT UNIQUE NOT NULL,
  color                       TEXT NOT NULL DEFAULT '#3B82F6',
  mileage_reward              INTEGER NOT NULL DEFAULT 0 CHECK (mileage_reward >= 0),
  referral_mileage_reward     INTEGER NOT NULL DEFAULT 0 CHECK (referral_mileage_reward >= 0),
  mileage_multiplier_bps      INTEGER CHECK (mileage_multiplier_bps IS NULL OR mileage_multiplier_bps BETWEEN 1000 AND 100000),
  mileage_multiplier_priority INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT);

CREATE TABLE templates (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE tenant_admin_audit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  line_account_id TEXT,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  detail_json     TEXT,
  created_at      TEXT NOT NULL,
  CHECK (tenant_id IS NOT NULL OR line_account_id IS NOT NULL)
);

CREATE TABLE tenant_admin_credentials (
  tenant_id            TEXT NOT NULL,
  staff_id             TEXT NOT NULL,
  login_id             TEXT NOT NULL COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1
                       CHECK (must_change_password IN (0, 1)),
  credential_version   INTEGER NOT NULL DEFAULT 1
                       CHECK (credential_version >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (tenant_id, staff_id),
  UNIQUE (tenant_id, login_id),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE CASCADE
);

CREATE TABLE tenant_admin_sessions (
  token_hash         TEXT PRIMARY KEY
                     CHECK (length(token_hash) = 64
                            AND token_hash NOT GLOB '*[^0-9a-f]*'),
  session_family_hash TEXT
                     CHECK (session_family_hash IS NULL OR
                            (length(session_family_hash) = 64
                             AND session_family_hash NOT GLOB '*[^0-9a-f]*')),
  tenant_id          TEXT NOT NULL,
  staff_id           TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  session_kind       TEXT NOT NULL CHECK (session_kind IN ('bootstrap', 'standard')),
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL, last_seen_at TEXT
  CHECK (last_seen_at IS NULL OR unixepoch(last_seen_at) IS NOT NULL),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE CASCADE
);

CREATE TABLE tenant_line_accounts (
  tenant_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, line_account_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE
);

CREATE TABLE tenant_staff_memberships (
  tenant_id  TEXT NOT NULL,
  staff_id   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, staff_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE tenants (
  id           TEXT PRIMARY KEY,
  tenant_code  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'suspended')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, outbound_messaging_paused_at TEXT);

CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, og_title TEXT, og_description TEXT, og_image_url TEXT, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, short_code TEXT, dedup_key TEXT);

CREATE TABLE traffic_pools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE update_history (
  id                          TEXT PRIMARY KEY,
  started_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  snapshot_worker_url         TEXT,
  snapshot_admin_deployment   TEXT,
  snapshot_liff_deployment    TEXT,
  events_jsonl                TEXT NOT NULL DEFAULT '',
  error                       TEXT,
  rollback_of                 TEXT REFERENCES update_history(id),
  rollback_expires_at         INTEGER
, release_evidence_json TEXT NOT NULL DEFAULT '{}');

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  phone        TEXT,
  external_id  TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE webinar_comments (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  at_seconds INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webinar_ctas (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  at_seconds INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('form', 'url')),
  title TEXT NOT NULL,
  body TEXT,
  button_label TEXT NOT NULL,
  auto_open INTEGER NOT NULL DEFAULT 0,
  form_id TEXT REFERENCES forms(id),
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webinar_followup_configs (
  webinar_id          TEXT PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
  enabled_at          TEXT NOT NULL,
  first_delay_minutes INTEGER NOT NULL DEFAULT 30,
  second_delay_minutes INTEGER NOT NULL DEFAULT 1440,
  is_active           INTEGER NOT NULL DEFAULT 1
, stage_enabled_at TEXT, picker_delay_minutes INTEGER NOT NULL DEFAULT 30, no_show_delay_minutes INTEGER NOT NULL DEFAULT 30, booking_delay_minutes INTEGER NOT NULL DEFAULT 30, booking_second_delay_minutes INTEGER NOT NULL DEFAULT 1440, booking_menu_id TEXT, booking_url TEXT);

CREATE TABLE webinar_followups (
  id             TEXT PRIMARY KEY,
  webinar_id     TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id      TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('after_30m', 'after_24h')),
  retry_key      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at        TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, kind)
);

CREATE TABLE webinar_funnel_events (
  id               TEXT PRIMARY KEY,
  webinar_id       TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id        TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  session_start_at INTEGER NOT NULL,
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'cta_impression',
    'cta_click',
    'form_open',
    'form_start',
    'field_complete',
    'submit_attempt',
    'submit_success',
    'submit_error'
  )),
  cta_id           TEXT NOT NULL DEFAULT '',
  form_id          TEXT NOT NULL DEFAULT '',
  field_name       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webinar_journey_followups (
  id          TEXT PRIMARY KEY,
  webinar_id  TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
    'picker_no_registration',
    'registered_no_show',
    'submitted_no_booking_30m',
    'submitted_no_booking_24h'
  )),
  retry_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  sent_at     TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, kind)
);

CREATE TABLE webinar_picker_opens (
  id              TEXT PRIMARY KEY,
  webinar_id      TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  opened_at       TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id)
);

CREATE TABLE webinar_registrations (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  notified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, session_start_at)
);

CREATE TABLE webinar_user_comments (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  at_seconds INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webinar_viewers (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  last_position_seconds INTEGER NOT NULL DEFAULT 0,
  cta_clicked_at TEXT,
  UNIQUE (webinar_id, friend_id, session_start_at)
);

CREATE TABLE webinars (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES line_accounts(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  video_prefix TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  schedule_json TEXT NOT NULL DEFAULT '[]',
  cta_json TEXT,
  tag_on_attend TEXT,
  tag_on_cta_click TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_ad_conversion_logs_friend ON ad_conversion_logs (friend_id);

CREATE INDEX idx_ad_conversion_logs_platform ON ad_conversion_logs (ad_platform_id);

CREATE INDEX idx_ad_conversion_logs_status ON ad_conversion_logs (status);

CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id);

CREATE INDEX idx_affiliate_links_affiliate ON affiliate_links (affiliate_id);

CREATE INDEX idx_affiliate_links_offer ON affiliate_links (offer_id);

CREATE UNIQUE INDEX idx_affiliates_friend ON affiliates (friend_id) WHERE friend_id IS NOT NULL;

CREATE INDEX idx_auto_replies_template_id ON auto_replies(template_id);

CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);

CREATE INDEX idx_automations_active ON automations (is_active);

CREATE INDEX idx_automations_event ON automations (event_type);

CREATE INDEX idx_bookings_account_status_starts ON bookings (line_account_id, status, starts_at);

CREATE INDEX idx_bookings_friend_starts ON bookings (friend_id, starts_at DESC);

CREATE INDEX idx_bookings_staff_overlap ON bookings (staff_id, status, starts_at, block_ends_at);

CREATE INDEX idx_broadcast_insights_broadcast_id ON broadcast_insights(broadcast_id);

CREATE INDEX idx_broadcast_insights_status ON broadcast_insights(status);

CREATE INDEX idx_broadcasts_status ON broadcasts (status);

CREATE INDEX idx_calendar_bookings_friend ON calendar_bookings (friend_id);

CREATE INDEX idx_calendar_bookings_start ON calendar_bookings (start_at);

CREATE UNIQUE INDEX idx_chats_friend_unique ON chats (friend_id);

CREATE INDEX idx_chats_operator ON chats (operator_id);

CREATE INDEX idx_chats_status ON chats (status);

CREATE INDEX idx_conversion_events_affiliate ON conversion_events (affiliate_code);

CREATE INDEX idx_conversion_events_friend ON conversion_events (friend_id);

CREATE INDEX idx_conversion_events_point ON conversion_events (conversion_point_id);

CREATE INDEX idx_engagement_events_actor_friend
  ON engagement_events(program_id, actor_friend_id, occurred_at DESC);

CREATE INDEX idx_engagement_events_actor_user
  ON engagement_events(program_id, actor_user_id, occurred_at DESC);

CREATE INDEX idx_engagement_events_source
  ON engagement_events(source, source_event_id);

CREATE INDEX idx_entry_routes_pool ON entry_routes (pool_id);

CREATE INDEX idx_entry_routes_ref ON entry_routes (ref_code);

CREATE INDEX idx_entry_routes_tenant_created
  ON entry_routes(tenant_id, created_at DESC);

CREATE INDEX idx_event_booking_idempotency_expires ON event_booking_idempotency_keys (expires_at);

CREATE INDEX idx_event_booking_reminders_status_scheduled ON event_booking_reminders (status, scheduled_at);

CREATE INDEX idx_event_bookings_account_status_event ON event_bookings (line_account_id, status, event_id);

CREATE INDEX idx_event_bookings_friend_requested ON event_bookings (friend_id, requested_at DESC);

CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);

CREATE INDEX idx_event_bookings_slot_status ON event_bookings (slot_id, status);

CREATE INDEX idx_event_slots_event_starts ON event_slots (event_id, starts_at);

CREATE INDEX idx_events_account_published_sort ON events (line_account_id, is_published, sort_order);

CREATE INDEX idx_form_opens_form ON form_opens (form_id, opened_at);

CREATE INDEX idx_form_submissions_form ON form_submissions (form_id);

CREATE INDEX idx_form_submissions_friend ON form_submissions (friend_id);

CREATE INDEX idx_forms_tenant_created
  ON forms(tenant_id, created_at DESC);

CREATE INDEX idx_friend_reminders_friend ON friend_reminders (friend_id);

CREATE INDEX idx_friend_reminders_status ON friend_reminders (status);

CREATE INDEX idx_friend_scenarios_friend_id ON friend_scenarios (friend_id);

CREATE INDEX idx_friend_scenarios_next_delivery_at ON friend_scenarios (next_delivery_at);

CREATE INDEX idx_friend_scenarios_status ON friend_scenarios (status);

CREATE UNIQUE INDEX idx_friend_scenarios_unique ON friend_scenarios (friend_id, scenario_id) WHERE status != 'completed';

CREATE INDEX idx_friend_scores_created ON friend_scores (created_at);

CREATE INDEX idx_friend_scores_friend ON friend_scores (friend_id);

CREATE INDEX idx_friend_tags_tag_id ON friend_tags (tag_id);

CREATE INDEX idx_friends_follow_tenure ON friends(is_following, current_follow_started_at);

CREATE UNIQUE INDEX idx_friends_id_line_account
  ON friends (id, line_account_id);

CREATE INDEX idx_friends_ig_igsid ON friends (ig_igsid);

CREATE INDEX idx_friends_line_user_id ON friends (line_user_id);

CREATE INDEX idx_friends_user_id ON friends (user_id);

CREATE INDEX idx_google_calendar_connections_staff
  ON google_calendar_connections (line_account_id, staff_id, is_active);

CREATE INDEX idx_google_calendar_connections_tenant_created
  ON google_calendar_connections(tenant_id, created_at DESC);

CREATE INDEX idx_health_logs_account ON account_health_logs (line_account_id);

CREATE INDEX idx_idempotency_expires ON booking_idempotency_keys (expires_at);

CREATE INDEX idx_incoming_webhooks_tenant_created
  ON incoming_webhooks(tenant_id, created_at DESC);

CREATE INDEX idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

CREATE UNIQUE INDEX idx_line_accounts_liff_unique
  ON line_accounts (liff_id)
  WHERE liff_id IS NOT NULL AND liff_id != '';

CREATE UNIQUE INDEX idx_line_accounts_login_channel_unique
  ON line_accounts (login_channel_id)
  WHERE login_channel_id IS NOT NULL AND login_channel_id != '';

CREATE INDEX idx_link_clicks_friend ON link_clicks (friend_id);

CREATE INDEX idx_link_clicks_link ON link_clicks (tracked_link_id);

CREATE INDEX idx_media_inquiries_created
  ON media_inquiries (created_at DESC);

CREATE INDEX idx_media_inquiries_mail_status
  ON media_inquiries (mail_status, created_at);

CREATE INDEX idx_meet_consultation_reminders_due
  ON meet_consultation_reminders (status, scheduled_at);

CREATE INDEX idx_meet_consultations_friend ON meet_consultations (friend_id);

CREATE INDEX idx_meet_consultations_start ON meet_consultations (status, starts_at);

CREATE INDEX idx_menus_account_sort ON menus (line_account_id, sort_order);

CREATE INDEX idx_message_templates_tenant_name
  ON message_templates(tenant_id, name);

CREATE INDEX idx_messages_log_account_created_at
  ON messages_log(
    line_account_id,
    julianday(CASE
      WHEN created_at GLOB '*Z' OR substr(created_at, -6, 1) IN ('+', '-')
        THEN created_at
      ELSE created_at || '+09:00'
    END)
  );

CREATE INDEX idx_messages_log_broadcast_id ON messages_log(broadcast_id);

CREATE INDEX idx_messages_log_created_at ON messages_log (created_at);

CREATE INDEX idx_messages_log_friend_direction_created ON messages_log (friend_id, direction, created_at);

CREATE INDEX idx_messages_log_friend_id ON messages_log (friend_id);

CREATE INDEX idx_messages_log_friend_source ON messages_log (friend_id, source);

CREATE UNIQUE INDEX idx_messages_log_outbound_operation
  ON messages_log(outbound_operation_id)
  WHERE outbound_operation_id IS NOT NULL;

CREATE INDEX idx_mileage_event_queue_due
  ON mileage_event_queue(status, available_at, created_at);

CREATE INDEX idx_mileage_ledger_friend
  ON mileage_ledger(program_id, beneficiary_friend_id, status, occurred_at DESC);

CREATE UNIQUE INDEX idx_mileage_ledger_one_reversal
  ON mileage_ledger(reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX idx_mileage_ledger_rule
  ON mileage_ledger(program_id, mileage_rule_id, occurred_at DESC);

CREATE INDEX idx_mileage_ledger_source
  ON mileage_ledger(program_id, source, source_event_id);

CREATE INDEX idx_mileage_ledger_user
  ON mileage_ledger(program_id, beneficiary_user_id, status, occurred_at DESC);

CREATE INDEX idx_mileage_rules_match
  ON mileage_rules(program_id, event_type, source, is_active);

CREATE INDEX idx_notifications_created ON notifications (created_at);

CREATE INDEX idx_notifications_status ON notifications (status);

CREATE INDEX idx_outbound_line_deliveries_reconcile
  ON outbound_line_deliveries(tenant_id, line_account_id, outcome, updated_at);

CREATE INDEX idx_outgoing_webhook_deliveries_reconcile
  ON outgoing_webhook_deliveries(tenant_id, line_account_id, outcome, updated_at);

CREATE INDEX idx_outgoing_webhooks_tenant_created
  ON outgoing_webhooks(tenant_id, created_at DESC);

CREATE INDEX idx_pharmacy_activity_notifications_open
  ON pharmacy_activity_notifications
     (line_account_id, acknowledged_at, created_at DESC, id DESC);

CREATE INDEX idx_pharmacy_cli_break_glass_active
  ON pharmacy_cli_break_glass_sessions (tenant_id, revoked_at, expires_at);

CREATE UNIQUE INDEX idx_pharmacy_continuity_account
  ON pharmacy_continuity_obligations (id, line_account_id);

CREATE INDEX idx_pharmacy_continuity_due
  ON pharmacy_continuity_obligations (line_account_id, status, next_contact_at, last_reminded_at);

CREATE INDEX idx_pharmacy_continuity_events_obligation
  ON pharmacy_continuity_events (line_account_id, obligation_id, created_at, id);

CREATE UNIQUE INDEX idx_pharmacy_continuity_open_patient
  ON pharmacy_continuity_obligations (line_account_id, patient_id)
  WHERE status IN ('active','linked');

CREATE INDEX idx_pharmacy_continuity_patient
  ON pharmacy_continuity_obligations (line_account_id, patient_id, created_at DESC, id);

CREATE INDEX idx_pharmacy_data_subject_request_events_request
  ON pharmacy_data_subject_request_events (line_account_id, request_id, occurred_at, id);

CREATE INDEX idx_pharmacy_data_subject_requests_patient
  ON pharmacy_data_subject_requests (line_account_id, patient_id, submitted_at DESC, id DESC);

CREATE INDEX idx_pharmacy_data_subject_requests_queue
  ON pharmacy_data_subject_requests (line_account_id, status, submitted_at DESC, id DESC);

CREATE INDEX idx_pharmacy_emergency_access_intake
  ON pharmacy_emergency_intake_access_events
    (line_account_id, intake_id, accessed_at, id);

CREATE INDEX idx_pharmacy_emergency_admin_events_account
  ON pharmacy_emergency_admin_events (line_account_id, occurred_at, id);

CREATE INDEX idx_pharmacy_emergency_events_intake
  ON pharmacy_emergency_intake_events (line_account_id, intake_id, occurred_at, id);

CREATE INDEX idx_pharmacy_emergency_intakes_owner
  ON pharmacy_emergency_intakes (line_account_id, owner_friend_id, created_at DESC, id DESC);

CREATE INDEX idx_pharmacy_emergency_intakes_queue
  ON pharmacy_emergency_intakes (line_account_id, status, expires_at, created_at, id);

CREATE INDEX idx_pharmacy_emergency_reminders_due
  ON pharmacy_emergency_reminders(status, due_at, deadline_at, line_account_id, id);

CREATE INDEX idx_pharmacy_emergency_retention_purge_log_account
  ON pharmacy_emergency_retention_purge_log (line_account_id, purged_at);

CREATE INDEX idx_pharmacy_emergency_retention_purge_log_purged
  ON pharmacy_emergency_retention_purge_log (purged_at, resource_type);

CREATE INDEX idx_pharmacy_emergency_sale_records_sold_at
  ON pharmacy_emergency_sale_records (line_account_id, sold_at);

CREATE INDEX idx_pharmacy_emergency_slots_available
  ON pharmacy_emergency_slots (line_account_id, status, starts_at, id);

CREATE INDEX idx_pharmacy_fulfillment_quotes_decision
  ON pharmacy_fulfillment_quotes (line_account_id, decision, created_at DESC);

CREATE INDEX idx_pharmacy_fulfillment_quotes_submission
  ON pharmacy_fulfillment_quotes (line_account_id, submission_id, revision DESC, created_at DESC);

CREATE INDEX idx_pharmacy_growth_events_account_time
  ON pharmacy_growth_events(line_account_id, occurred_at, event_type);

CREATE INDEX idx_pharmacy_incoming_image_dispositions_queue
  ON pharmacy_incoming_image_dispositions (status, updated_at, r2_key);

CREATE INDEX idx_pharmacy_incoming_image_dispositions_scope
  ON pharmacy_incoming_image_dispositions (tenant_id, line_account_id, status, stored_at);

CREATE INDEX idx_pharmacy_incoming_image_objects_account
  ON pharmacy_incoming_image_objects (line_account_id, stored_at);

CREATE INDEX idx_pharmacy_intake_responses_patient
  ON pharmacy_patient_intake_responses (line_account_id, patient_id, revision DESC, id DESC);

CREATE INDEX idx_pharmacy_line_credentials_access_token
  ON pharmacy_line_credentials (lookup_digest)
  WHERE credential_kind = 'channel_access_token' AND lookup_digest IS NOT NULL;

CREATE INDEX idx_pharmacy_medical_sources_account
  ON pharmacy_medical_sources(line_account_id, is_active, classification);

CREATE UNIQUE INDEX idx_pharmacy_medical_sources_id_account
  ON pharmacy_medical_sources(id, line_account_id);

CREATE INDEX idx_pharmacy_medication_followup_events_followup
  ON pharmacy_medication_followup_events
     (line_account_id, followup_id, occurred_at DESC, id DESC);

CREATE INDEX idx_pharmacy_medication_followups_due
  ON pharmacy_medication_followups (line_account_id, status, due_at, id);

CREATE INDEX idx_pharmacy_medication_followups_patient
  ON pharmacy_medication_followups (line_account_id, patient_id, created_at DESC, id DESC);

CREATE INDEX idx_pharmacy_myna_endpoint_account
  ON pharmacy_myna_endpoint_configs (line_account_id, revision DESC, updated_at DESC);

CREATE UNIQUE INDEX idx_pharmacy_myna_endpoint_active_account
  ON pharmacy_myna_endpoint_configs (line_account_id)
  WHERE enabled = 1 AND retired_at IS NULL;

CREATE INDEX idx_pharmacy_myna_events_handoff
  ON pharmacy_myna_events (line_account_id, handoff_id, occurred_at, id);

CREATE INDEX idx_pharmacy_myna_handoffs_friend
  ON pharmacy_myna_handoffs (line_account_id, friend_id, created_at DESC, id);

CREATE INDEX idx_pharmacy_myna_handoffs_queue
  ON pharmacy_myna_handoffs (line_account_id, status, created_at DESC, id);

CREATE INDEX idx_pharmacy_myna_verifications_handoff
  ON pharmacy_myna_verifications (line_account_id, handoff_id, verified_at DESC, id);

CREATE INDEX idx_pharmacy_next_intake_expectation_events_item
  ON pharmacy_next_intake_expectation_events
     (line_account_id, expectation_id, occurred_at DESC, id DESC);

CREATE INDEX idx_pharmacy_next_intake_expectations_due
  ON pharmacy_next_intake_expectations
     (line_account_id, status, reminder_at, id);

CREATE INDEX idx_pharmacy_next_intake_expectations_patient
  ON pharmacy_next_intake_expectations
     (line_account_id, patient_id, created_at DESC, id DESC);

CREATE INDEX idx_pharmacy_notification_events_exposure
  ON pharmacy_notification_events(line_account_id, friend_id, occurred_at, category, outcome);

CREATE INDEX idx_pharmacy_patient_intake_envelopes_scope
  ON pharmacy_patient_intake_envelopes
    (tenant_id, line_account_id, owner_friend_id, patient_id, response_id, field_name);

CREATE INDEX idx_pharmacy_patient_intake_migration_state_scope
  ON pharmacy_patient_intake_migration_state (tenant_id, line_account_id, phase);

CREATE UNIQUE INDEX idx_pharmacy_patient_intake_responses_envelope_scope
  ON pharmacy_patient_intake_responses
    (id, patient_id, line_account_id, owner_friend_id, schema_version, revision);

CREATE UNIQUE INDEX idx_pharmacy_patients_active_self
  ON pharmacy_patients (line_account_id, owner_friend_id)
  WHERE relationship = 'self' AND archived_at IS NULL;

CREATE INDEX idx_pharmacy_patients_owner
  ON pharmacy_patients (line_account_id, owner_friend_id, archived_at, updated_at DESC, id);

CREATE INDEX idx_pharmacy_phi_retention_purge_log_purged
  ON pharmacy_phi_retention_purge_log (purged_at, resource_type);

CREATE INDEX idx_pharmacy_prescription_events_submission
  ON pharmacy_prescription_events (submission_id, created_at, id);

CREATE INDEX idx_pharmacy_prescription_expectations_queue
  ON pharmacy_prescription_expectations (line_account_id, receipt_status, updated_at DESC, id);

CREATE INDEX idx_pharmacy_prescription_files_revision
  ON pharmacy_prescription_files (submission_id, revision, position);

CREATE INDEX idx_pharmacy_prescription_patients_patient
  ON pharmacy_prescription_patients (line_account_id, patient_id, created_at DESC, submission_id);

CREATE UNIQUE INDEX idx_pharmacy_prescription_submissions_account
  ON pharmacy_prescription_submissions (id, line_account_id);

CREATE UNIQUE INDEX idx_pharmacy_prescription_submissions_id_account
  ON pharmacy_prescription_submissions(id, line_account_id);

CREATE UNIQUE INDEX idx_pharmacy_prescription_submissions_scope
  ON pharmacy_prescription_submissions (id, line_account_id, friend_id);

CREATE INDEX idx_pharmacy_prescription_validities_queue
  ON pharmacy_prescription_validities(line_account_id, verification_status, reminder_due_at);

CREATE INDEX idx_pharmacy_prescription_view_events_submission
  ON pharmacy_prescription_view_events (submission_id, viewed_at);

CREATE INDEX idx_pharmacy_prescriptions_account_status_requested
  ON pharmacy_prescription_submissions (line_account_id, status, requested_at, id);

CREATE INDEX idx_pharmacy_prescriptions_friend_history
  ON pharmacy_prescription_submissions (line_account_id, friend_id, created_at DESC, id DESC);

CREATE INDEX idx_pharmacy_print_tasks_open
  ON pharmacy_print_tasks (line_account_id, status, created_at, id);

CREATE INDEX idx_pharmacy_recovery_backup_generations_scope
  ON pharmacy_recovery_backup_generations
    (tenant_id, line_account_id, environment, status, verified_at);

CREATE UNIQUE INDEX idx_pharmacy_recovery_execution_fences_active_scope
  ON pharmacy_recovery_execution_fences (tenant_id, line_account_id, environment)
  WHERE status = 'active';

CREATE INDEX idx_pharmacy_recovery_execution_fences_scope_status
  ON pharmacy_recovery_execution_fences
    (tenant_id, line_account_id, environment, status, expires_at);

CREATE UNIQUE INDEX idx_pharmacy_recovery_operations_idempotency
  ON pharmacy_recovery_operations
    (tenant_id, line_account_id, environment, operation, idempotency_key);

CREATE INDEX idx_pharmacy_recovery_operations_scope_status
  ON pharmacy_recovery_operations
    (tenant_id, line_account_id, environment, status, updated_at);

CREATE INDEX idx_pharmacy_retention_deletion_intents_queue
  ON pharmacy_retention_deletion_intents (status, updated_at, id);

CREATE INDEX idx_pharmacy_retention_deletion_intents_scope
  ON pharmacy_retention_deletion_intents
     (tenant_id, line_account_id, resource_type, resource_id, status);

CREATE INDEX idx_pharmacy_retention_hold_epochs_scope
  ON pharmacy_retention_hold_epochs
     (tenant_id, line_account_id, owner_friend_id, patient_key, epoch);

CREATE INDEX idx_pharmacy_rich_menu_draft_account
  ON pharmacy_rich_menu_draft_bindings(line_account_id, created_at, group_id);

CREATE UNIQUE INDEX idx_pharmacy_rich_menu_one_unresolved
  ON pharmacy_rich_menu_operations(line_account_id)
  WHERE status IN ('running', 'unknown');

CREATE INDEX idx_pharmacy_rich_menu_operation_confirmations_operation
  ON pharmacy_rich_menu_operation_confirmations(line_account_id, operation_id, created_at);

CREATE INDEX idx_pharmacy_rich_menu_operations_group
  ON pharmacy_rich_menu_operations(line_account_id, group_id, created_at);

CREATE INDEX idx_pharmacy_staff_accounts_staff
  ON pharmacy_staff_accounts (staff_id, is_active, line_account_id);

CREATE INDEX idx_pharmacy_submission_sources_account
  ON pharmacy_submission_sources(line_account_id, classification, entered_at);

CREATE INDEX idx_pharmacy_tenant_provisioning_tenant
  ON pharmacy_tenant_provisioning_requests (tenant_id, created_at);

CREATE INDEX idx_pharmacy_webhook_event_receipts_received
  ON pharmacy_webhook_event_receipts (received_at);

CREATE INDEX idx_pharmacy_webhook_event_receipts_sweep
  ON pharmacy_webhook_event_receipts (lease_until, received_at)
  WHERE status <> 'completed' AND dead_lettered_at IS NULL;

CREATE INDEX idx_platform_admin_access_events_admin
  ON platform_admin_access_events (platform_admin_id, created_at);

CREATE INDEX idx_platform_admin_access_events_tenant
  ON platform_admin_access_events (tenant_id, created_at);

CREATE INDEX idx_platform_admin_access_grants_active
  ON platform_admin_access_grants (platform_admin_id, tenant_id, expires_at, revoked_at);

CREATE INDEX idx_platform_admin_sessions_staff
  ON platform_admin_sessions (staff_id, revoked_at, expires_at);

CREATE UNIQUE INDEX idx_platform_admins_one_key_bootstrap
  ON platform_admins (granted_by) WHERE granted_by = 'platform-admin-key';

CREATE INDEX idx_ref_tracking_friend ON ref_tracking (friend_id);

CREATE INDEX idx_ref_tracking_friend_created ON ref_tracking(friend_id, created_at);

CREATE INDEX idx_ref_tracking_ref    ON ref_tracking (ref_code);

CREATE INDEX idx_ref_tracking_ref_created ON ref_tracking(ref_code, created_at);

CREATE INDEX idx_reminder_steps_reminder ON reminder_steps (reminder_id);

CREATE INDEX idx_reminders_status_scheduled ON booking_reminders (status, scheduled_at);

CREATE INDEX idx_rich_menu_areas_page     ON rich_menu_areas(page_id);

CREATE INDEX idx_rich_menu_groups_account ON rich_menu_groups(account_id, status);

CREATE INDEX idx_rich_menu_pages_group    ON rich_menu_pages(group_id, order_index);

CREATE INDEX idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);

CREATE INDEX idx_scenarios_tenant_account
  ON scenarios (tenant_id, line_account_id);

CREATE INDEX idx_shifts_staff_date ON staff_shifts (staff_id, work_date);

CREATE INDEX idx_staff_account_sort ON staff (line_account_id, sort_order);

CREATE INDEX idx_staff_availability_rules_staff
  ON staff_availability_rules (staff_id, weekday, is_active);

CREATE UNIQUE INDEX idx_staff_members_api_key ON staff_members(api_key);

CREATE UNIQUE INDEX idx_staff_members_api_key_hash
  ON staff_members(api_key_hash);

CREATE INDEX idx_staff_members_role ON staff_members(role);

CREATE INDEX idx_stripe_events_friend ON stripe_events (friend_id);

CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);

CREATE INDEX idx_tags_tenant_name
  ON tags(tenant_id, name);

CREATE INDEX idx_templates_category ON templates (category);

CREATE INDEX idx_templates_tenant_category_created
  ON templates(tenant_id, category, created_at DESC);

CREATE INDEX idx_tenant_admin_audit_events_account
  ON tenant_admin_audit_events (line_account_id, created_at);

CREATE INDEX idx_tenant_admin_audit_events_tenant
  ON tenant_admin_audit_events (tenant_id, created_at);

CREATE INDEX idx_tenant_admin_credentials_login
  ON tenant_admin_credentials (tenant_id, login_id);

CREATE INDEX idx_tenant_admin_sessions_staff
  ON tenant_admin_sessions (tenant_id, staff_id, revoked_at, expires_at);

CREATE INDEX idx_tenant_line_accounts_tenant
  ON tenant_line_accounts (tenant_id, line_account_id);

CREATE INDEX idx_tenant_staff_memberships_staff
  ON tenant_staff_memberships (staff_id, is_active, tenant_id);

CREATE UNIQUE INDEX idx_tracked_links_dedup_key
  ON tracked_links (dedup_key) WHERE dedup_key IS NOT NULL;

CREATE UNIQUE INDEX idx_tracked_links_short_code
  ON tracked_links (short_code) WHERE short_code IS NOT NULL;

CREATE INDEX idx_traffic_pools_tenant_created
  ON traffic_pools(tenant_id, created_at DESC);

CREATE INDEX idx_update_history_started ON update_history(started_at DESC);

CREATE INDEX idx_users_email ON users (email);

CREATE INDEX idx_users_external_id ON users (external_id);

CREATE INDEX idx_users_phone ON users (phone);

CREATE INDEX idx_webinar_comments_webinar
  ON webinar_comments (webinar_id, at_seconds);

CREATE INDEX idx_webinar_ctas_webinar
  ON webinar_ctas (webinar_id, at_seconds);

CREATE INDEX idx_webinar_followups_status
  ON webinar_followups (status, updated_at);

CREATE UNIQUE INDEX idx_webinar_funnel_events_unique
  ON webinar_funnel_events (
    webinar_id, friend_id, session_start_at, event_type, cta_id, form_id, field_name
  );

CREATE INDEX idx_webinar_funnel_events_webinar_created
  ON webinar_funnel_events (webinar_id, created_at);

CREATE INDEX idx_webinar_journey_followups_status
  ON webinar_journey_followups (status, updated_at);

CREATE INDEX idx_webinar_picker_opens_opened
  ON webinar_picker_opens (webinar_id, opened_at);

CREATE INDEX idx_webinar_regs_due
  ON webinar_registrations (notified_at, session_start_at);

CREATE INDEX idx_webinar_regs_friend
  ON webinar_registrations (webinar_id, friend_id);

CREATE INDEX idx_webinar_user_comments_webinar
  ON webinar_user_comments (webinar_id, created_at);

CREATE INDEX idx_webinar_viewers_webinar
  ON webinar_viewers (webinar_id, session_start_at);

CREATE UNIQUE INDEX uq_friends_account_provider_user
  ON friends (line_account_id, provider_line_user_id)
  WHERE line_account_id IS NOT NULL AND provider_line_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_friends_unowned_provider_user
  ON friends (provider_line_user_id)
  WHERE line_account_id IS NULL AND provider_line_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_google_calendar_connections_active_staff
  ON google_calendar_connections (staff_id)
  WHERE staff_id IS NOT NULL AND is_active = 1;

CREATE UNIQUE INDEX uq_rich_menu_groups_account_generator
  ON rich_menu_groups (account_id, generator_key)
  WHERE generator_key IS NOT NULL;

CREATE TRIGGER auto_replies_template_scope_insert
BEFORE INSERT ON auto_replies
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'AUTO_REPLY_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER auto_replies_template_scope_update
BEFORE UPDATE OF template_id, line_account_id ON auto_replies
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'AUTO_REPLY_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER calendar_bookings_account_scope_insert
BEFORE INSERT ON calendar_bookings
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM google_calendar_connections AS connection
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
   WHERE connection.id = NEW.connection_id
     AND connection.line_account_id IS friend.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'CALENDAR_BOOKING_ACCOUNT_SCOPE_MISMATCH'); END;

CREATE TRIGGER calendar_bookings_account_scope_update
BEFORE UPDATE OF connection_id, friend_id ON calendar_bookings
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM google_calendar_connections AS connection
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
   WHERE connection.id = NEW.connection_id
     AND connection.line_account_id IS friend.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'CALENDAR_BOOKING_ACCOUNT_SCOPE_MISMATCH'); END;

CREATE TRIGGER entry_routes_resource_scope_insert
BEFORE INSERT ON entry_routes
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios WHERE id = NEW.scenario_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.pool_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM traffic_pools WHERE id = NEW.pool_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates
         WHERE id = NEW.intro_template_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'ENTRY_ROUTE_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER entry_routes_resource_scope_update
BEFORE UPDATE OF tenant_id, tag_id, scenario_id, pool_id, intro_template_id ON entry_routes
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios WHERE id = NEW.scenario_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.pool_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM traffic_pools WHERE id = NEW.pool_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates
         WHERE id = NEW.intro_template_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'ENTRY_ROUTE_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER form_submissions_tenant_scope_insert
BEFORE INSERT ON form_submissions
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM forms AS form
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE form.id = NEW.form_id
     AND form.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FORM_SUBMISSION_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER form_submissions_tenant_scope_update
BEFORE UPDATE OF form_id, friend_id ON form_submissions
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM forms AS form
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE form.id = NEW.form_id
     AND form.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FORM_SUBMISSION_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER forms_resource_scope_insert
BEFORE INSERT ON forms
WHEN (NEW.on_submit_tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.on_submit_tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.on_submit_scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios
         WHERE id = NEW.on_submit_scenario_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'FORM_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER forms_resource_scope_update
BEFORE UPDATE OF tenant_id, on_submit_tag_id, on_submit_scenario_id ON forms
WHEN (NEW.on_submit_tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.on_submit_tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.on_submit_scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios
         WHERE id = NEW.on_submit_scenario_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'FORM_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER friends_account_immutable BEFORE UPDATE OF line_account_id ON friends WHEN OLD.line_account_id IS NOT NULL AND NEW.line_account_id IS NOT OLD.line_account_id BEGIN SELECT RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE'); END;

CREATE TRIGGER friends_provider_id_compat_insert AFTER INSERT ON friends WHEN NEW.provider_line_user_id IS NULL BEGIN UPDATE friends SET provider_line_user_id = NEW.line_user_id WHERE id = NEW.id; END;

CREATE TRIGGER friends_provider_id_required_update BEFORE UPDATE OF provider_line_user_id ON friends WHEN NEW.provider_line_user_id IS NULL BEGIN SELECT RAISE(ABORT, 'FRIEND_PROVIDER_LINE_USER_ID_REQUIRED'); END;

CREATE TRIGGER google_calendar_connections_account_scope_insert
BEFORE INSERT ON google_calendar_connections
WHEN (NEW.tenant_id IS NULL AND NEW.line_account_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts WHERE line_account_id = NEW.line_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.line_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'CALENDAR_CONNECTION_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER google_calendar_connections_account_scope_update
BEFORE UPDATE OF tenant_id, line_account_id ON google_calendar_connections
WHEN (NEW.tenant_id IS NULL AND NEW.line_account_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts WHERE line_account_id = NEW.line_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.line_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'CALENDAR_CONNECTION_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER line_accounts_default_pharmacy_capability
AFTER INSERT ON line_accounts
BEGIN
  INSERT OR IGNORE INTO pharmacy_account_capabilities
    (line_account_id, mode, capabilities_json, proactive_monthly_limit,
     unfollow_alert_state, created_at, updated_at)
  VALUES (
    NEW.id, 'pharmacy',
    '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","emergency_contraception","manual_chat","pharmacy_info","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]',
    1, 'alert_only',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ); END;

CREATE TRIGGER pharmacy_capability_emergency_mirror_disable
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM json_each(NEW.capabilities_json)
   WHERE value = 'emergency_contraception'
)
BEGIN
  UPDATE pharmacy_emergency_settings
     SET is_enabled = 0, updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND is_enabled = 1; END;

CREATE TRIGGER pharmacy_capability_emergency_mirror_enable
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.capabilities_json)
   WHERE value = 'emergency_contraception'
)
BEGIN
  UPDATE pharmacy_emergency_settings
     SET is_enabled = 1, updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND is_enabled = 0; END;

CREATE TRIGGER pharmacy_capability_revision_insert
AFTER INSERT ON pharmacy_account_capabilities
BEGIN
  INSERT OR IGNORE INTO pharmacy_account_capability_revisions
    (line_account_id, revision, updated_at)
  VALUES (NEW.line_account_id, 1, NEW.updated_at); END;

CREATE TRIGGER pharmacy_capability_revision_update
AFTER UPDATE OF capabilities_json ON pharmacy_account_capabilities
WHEN OLD.capabilities_json <> NEW.capabilities_json
BEGIN
  INSERT INTO pharmacy_account_capability_revisions
    (line_account_id, revision, updated_at)
  VALUES (NEW.line_account_id, 1, NEW.updated_at)
  ON CONFLICT(line_account_id) DO UPDATE SET
    revision = revision + 1,
    updated_at = NEW.updated_at; END;

CREATE TRIGGER pharmacy_cli_break_glass_delete
BEFORE DELETE ON pharmacy_cli_break_glass_sessions
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CLI_BREAK_GLASS_SESSION_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_cli_break_glass_update
BEFORE UPDATE ON pharmacy_cli_break_glass_sessions
WHEN OLD.revoked_at IS NOT NULL OR
     NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR
     NEW.id IS NOT OLD.id OR
     NEW.token_hash IS NOT OLD.token_hash OR
     NEW.platform_admin_id IS NOT OLD.platform_admin_id OR
     NEW.tenant_id IS NOT OLD.tenant_id OR
     NEW.staff_id IS NOT OLD.staff_id OR
     NEW.operation_scope IS NOT OLD.operation_scope OR
     NEW.reason IS NOT OLD.reason OR
     NEW.ticket_reference IS NOT OLD.ticket_reference OR
     NEW.issued_at IS NOT OLD.issued_at OR
     NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CLI_BREAK_GLASS_SESSION_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_continuity_events_submission_scope_insert BEFORE INSERT ON pharmacy_continuity_events WHEN NEW.submission_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_prescription_submissions AS submission WHERE submission.id = NEW.submission_id AND submission.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_CONTINUITY_SUBMISSION_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_continuity_events_submission_scope_update BEFORE UPDATE OF submission_id, line_account_id ON pharmacy_continuity_events WHEN NEW.submission_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_prescription_submissions AS submission WHERE submission.id = NEW.submission_id AND submission.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_CONTINUITY_SUBMISSION_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_data_subject_events_no_delete
BEFORE DELETE ON pharmacy_data_subject_request_events
BEGIN SELECT RAISE(ABORT, 'DATA_SUBJECT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_data_subject_events_no_update
BEFORE UPDATE ON pharmacy_data_subject_request_events
BEGIN SELECT RAISE(ABORT, 'DATA_SUBJECT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_admin_events_no_delete
BEFORE DELETE ON pharmacy_emergency_admin_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_admin_events_no_update
BEFORE UPDATE ON pharmacy_emergency_admin_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_completion_consume_stock
AFTER UPDATE OF status ON pharmacy_emergency_intakes
WHEN NEW.status = 'completed' AND OLD.status <> 'completed'
BEGIN UPDATE pharmacy_emergency_inventory
     SET on_hand = on_hand - 1,
         version = version + 1,
         updated_at = NEW.updated_at
   WHERE line_account_id = NEW.line_account_id
     AND product_code = NEW.product_code; END;

CREATE TRIGGER pharmacy_emergency_completion_stock_guard
BEFORE UPDATE OF status ON pharmacy_emergency_intakes
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_inventory AS inventory
   WHERE inventory.line_account_id = NEW.line_account_id
     AND inventory.product_code = NEW.product_code
     AND inventory.on_hand > 0
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_STOCK_UNAVAILABLE'); END;

CREATE TRIGGER pharmacy_emergency_events_no_delete
BEFORE DELETE ON pharmacy_emergency_intake_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_events_no_update
BEFORE UPDATE ON pharmacy_emergency_intake_events
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_intake_active_assignment
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_slots AS slot
    INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
            ON pharmacist.line_account_id = slot.line_account_id
           AND pharmacist.staff_id = slot.pharmacist_staff_id
           AND pharmacist.is_active = 1
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = pharmacist.line_account_id
           AND assignment.staff_id = pharmacist.staff_id
           AND assignment.is_active = 1
   WHERE slot.id = NEW.slot_id AND slot.line_account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SERVICE_NOT_READY'); END;

CREATE TRIGGER pharmacy_emergency_intake_readiness
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_settings AS settings
    INNER JOIN pharmacy_emergency_slots AS slot
            ON slot.id = NEW.slot_id
           AND slot.line_account_id = settings.line_account_id
           AND slot.status = 'open'
           AND slot.starts_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
            ON pharmacist.line_account_id = slot.line_account_id
           AND pharmacist.staff_id = slot.pharmacist_staff_id
           AND pharmacist.is_active = 1
   WHERE settings.line_account_id = NEW.line_account_id
     AND settings.is_enabled = 1
     AND settings.privacy_space_ready = 1
     AND settings.drinking_water_ready = 1
     AND length(trim(settings.pharmacy_registration_number)) > 0
     AND length(trim(settings.product_code)) > 0
     AND length(trim(settings.manufacturer_check_url)) > 0
     AND length(trim(settings.privacy_policy_url)) > 0
     AND length(trim(settings.privacy_contact)) > 0
     AND length(trim(settings.partner_clinic_url)) > 0
     AND length(trim(settings.support_center_url)) > 0
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SERVICE_NOT_READY'); END;

CREATE TRIGGER pharmacy_emergency_intake_slot_capacity
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN (
  SELECT COUNT(*)
    FROM pharmacy_emergency_intakes AS active
   WHERE active.line_account_id = NEW.line_account_id
     AND active.slot_id = NEW.slot_id
     AND active.status IN ('provisional', 'reviewed')
     AND active.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) >= COALESCE((
  SELECT slot.capacity
    FROM pharmacy_emergency_slots AS slot
   WHERE slot.id = NEW.slot_id AND slot.line_account_id = NEW.line_account_id
), 0)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SLOT_UNAVAILABLE'); END;

CREATE TRIGGER pharmacy_emergency_intake_stock
BEFORE INSERT ON pharmacy_emergency_intakes
WHEN (
  SELECT COUNT(*)
    FROM pharmacy_emergency_intakes AS active
   WHERE active.line_account_id = NEW.line_account_id
     AND active.product_code = NEW.product_code
     AND active.status IN ('provisional', 'reviewed')
     AND active.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) >= COALESCE((
  SELECT inventory.on_hand
    FROM pharmacy_emergency_inventory AS inventory
   WHERE inventory.line_account_id = NEW.line_account_id
     AND inventory.product_code = NEW.product_code
), 0)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_STOCK_UNAVAILABLE'); END;

CREATE TRIGGER pharmacy_emergency_reminder_identity_immutable
BEFORE UPDATE ON pharmacy_emergency_reminders
WHEN NEW.line_account_id IS NOT OLD.line_account_id
  OR NEW.intake_id IS NOT OLD.intake_id
  OR NEW.reminder_kind IS NOT OLD.reminder_kind
  OR NEW.anchor_at IS NOT OLD.anchor_at
  OR NEW.due_at IS NOT OLD.due_at
  OR NEW.deadline_at IS NOT OLD.deadline_at
  OR NEW.occurrence_hash IS NOT OLD.occurrence_hash
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_REMINDER_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_reminder_terminal_immutable
BEFORE UPDATE ON pharmacy_emergency_reminders
WHEN OLD.status IN ('sent', 'suppressed')
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_REMINDER_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_sale_owner_match
BEFORE INSERT ON pharmacy_emergency_sale_records
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_emergency_intakes AS intake
   WHERE intake.id = NEW.intake_id
     AND intake.line_account_id = NEW.line_account_id
     AND intake.owner_friend_id = NEW.owner_friend_id
)
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_OWNER_MISMATCH'); END;

CREATE TRIGGER pharmacy_emergency_sale_records_no_delete
BEFORE DELETE ON pharmacy_emergency_sale_records
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_RECORD_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_emergency_sale_records_no_update
BEFORE UPDATE ON pharmacy_emergency_sale_records
BEGIN SELECT RAISE(ABORT, 'EMERGENCY_SALE_RECORD_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_myna_handoffs_expectation_scope_insert BEFORE INSERT ON pharmacy_myna_handoffs WHEN NEW.expectation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_prescription_expectations AS expectation WHERE expectation.id = NEW.expectation_id AND expectation.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_MYNA_EXPECTATION_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_myna_handoffs_expectation_scope_update BEFORE UPDATE OF expectation_id, line_account_id ON pharmacy_myna_handoffs WHEN NEW.expectation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_prescription_expectations AS expectation WHERE expectation.id = NEW.expectation_id AND expectation.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_MYNA_EXPECTATION_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_patient_intake_base_scope_insert BEFORE INSERT ON pharmacy_patient_intake_responses WHEN NEW.base_response_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_patient_intake_responses AS base WHERE base.id = NEW.base_response_id AND base.line_account_id = NEW.line_account_id AND base.owner_friend_id = NEW.owner_friend_id AND base.patient_id = NEW.patient_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_INTAKE_BASE_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_patient_intake_base_scope_update BEFORE UPDATE OF base_response_id, line_account_id, owner_friend_id, patient_id ON pharmacy_patient_intake_responses WHEN NEW.base_response_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_patient_intake_responses AS base WHERE base.id = NEW.base_response_id AND base.line_account_id = NEW.line_account_id AND base.owner_friend_id = NEW.owner_friend_id AND base.patient_id = NEW.patient_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_INTAKE_BASE_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_prescription_submissions_source_handoff_scope_insert BEFORE INSERT ON pharmacy_prescription_submissions WHEN NEW.source_handoff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_myna_handoffs AS handoff WHERE handoff.id = NEW.source_handoff_id AND handoff.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_prescription_submissions_source_handoff_scope_update BEFORE UPDATE OF source_handoff_id, line_account_id ON pharmacy_prescription_submissions WHEN NEW.source_handoff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_myna_handoffs AS handoff WHERE handoff.id = NEW.source_handoff_id AND handoff.line_account_id = NEW.line_account_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_rich_menu_draft_account_scope
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id AND account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_DRAFT_ACCOUNT_MISMATCH'); END;

CREATE TRIGGER pharmacy_rich_menu_draft_immutable
BEFORE UPDATE ON pharmacy_rich_menu_draft_bindings
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_DRAFT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_rich_menu_draft_size
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id
     AND account_id = NEW.line_account_id
     AND size <> NEW.menu_size
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_GROUP_SIZE_MISMATCH'); END;

CREATE TRIGGER pharmacy_rich_menu_draft_status
BEFORE INSERT ON pharmacy_rich_menu_draft_bindings
WHEN EXISTS (
  SELECT 1 FROM rich_menu_groups
   WHERE id = NEW.group_id
     AND account_id = NEW.line_account_id
     AND status <> 'draft'
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_GROUP_NOT_DRAFT'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_account_scope
BEFORE INSERT ON pharmacy_rich_menu_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_rich_menu_draft_bindings binding
    JOIN rich_menu_groups menu_group ON menu_group.id = binding.group_id
   WHERE binding.group_id = NEW.group_id
     AND binding.line_account_id = NEW.line_account_id
     AND menu_group.account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_ACCOUNT_MISMATCH'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_default_read_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.default_read_at IS NOT NULL
 AND (NEW.expected_default_menu_id IS NOT OLD.expected_default_menu_id
   OR NEW.default_read_at IS NOT OLD.default_read_at)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_DEFAULT_READ_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_identity_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.group_id IS NOT OLD.group_id
  OR NEW.line_account_id IS NOT OLD.line_account_id
  OR NEW.confirmation_id IS NOT OLD.confirmation_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.evidence_digest IS NOT OLD.evidence_digest
  OR NEW.publish_alias_id IS NOT OLD.publish_alias_id
  OR NEW.publish_menu_name IS NOT OLD.publish_menu_name
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_insert_running
BEFORE INSERT ON pharmacy_rich_menu_operations
WHEN NEW.status <> 'running'
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_MUST_START_RUNNING'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_no_resume_unknown
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.status = 'unknown' AND NEW.status = 'running'
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_UNKNOWN_REQUIRES_RECONCILIATION'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_protected_delete
BEFORE DELETE ON pharmacy_rich_menu_operations
WHEN OLD.status <> 'failed' OR OLD.remote_rich_menu_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PROTECTED'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_publish_phase_evidence
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.kind = 'publish'
 AND (
   (NEW.publish_phase IN ('remote_created', 'image_uploaded', 'alias_created', 'committed')
     AND NEW.remote_rich_menu_id IS NULL)
   OR
   (NEW.publish_phase = 'committed' AND NOT EXISTS (
     SELECT 1 FROM rich_menu_pages page
      WHERE page.group_id = NEW.group_id
        AND page.line_richmenu_id = NEW.remote_rich_menu_id
        AND page.alias_id = NEW.publish_alias_id
   ))
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PUBLISH_PHASE_EVIDENCE_REQUIRED'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_publish_phase_order
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.publish_phase IS NOT OLD.publish_phase
 AND NOT (
   (OLD.publish_phase = 'intent_recorded' AND NEW.publish_phase = 'remote_created')
   OR (OLD.publish_phase = 'remote_created' AND NEW.publish_phase = 'image_uploaded')
   OR (OLD.publish_phase = 'image_uploaded' AND NEW.publish_phase = 'alias_created')
   OR (OLD.publish_phase = 'alias_created' AND NEW.publish_phase = 'committed')
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PUBLISH_PHASE_INVALID'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_remote_id_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.remote_rich_menu_id IS NOT NULL
 AND NEW.remote_rich_menu_id IS NOT OLD.remote_rich_menu_id
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_REMOTE_ID_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_success_evidence
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.status = 'succeeded'
 AND (
   NEW.remote_rich_menu_id IS NULL
   OR NEW.verified_at IS NULL
   OR (NEW.kind = 'publish' AND NEW.publish_phase <> 'committed')
   OR (NEW.kind IN ('set_default', 'rollback')
     AND (NEW.default_read_at IS NULL
       OR NEW.verified_default_menu_id IS NOT NEW.remote_rich_menu_id))
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_SUCCESS_EVIDENCE_REQUIRED'); END;

CREATE TRIGGER pharmacy_rich_menu_operation_terminal_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.status IN ('succeeded', 'failed')
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_rich_menu_resume_confirmation_scope
BEFORE INSERT ON pharmacy_rich_menu_operation_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM pharmacy_rich_menu_operations operation
   WHERE operation.id = NEW.operation_id
     AND operation.line_account_id = NEW.line_account_id
     AND operation.kind = 'publish'
     AND operation.status IN ('running', 'unknown')
     AND operation.publish_phase = NEW.publish_phase
     AND operation.evidence_digest = NEW.evidence_digest
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_RESUME_CONFIRMATION_EVIDENCE_MISMATCH'); END;

CREATE TRIGGER pharmacy_staff_accounts_keep_active_assignee
BEFORE UPDATE OF line_account_id, staff_id, is_active ON pharmacy_staff_accounts
WHEN OLD.is_active = 1
 AND (
   NEW.line_account_id != OLD.line_account_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.is_active != 1
 )
 AND EXISTS (
   SELECT 1
     FROM tenant_line_accounts AS mapping
     INNER JOIN tenant_staff_memberships AS membership
             ON membership.tenant_id = mapping.tenant_id
            AND membership.staff_id = OLD.staff_id
    WHERE mapping.line_account_id = OLD.line_account_id
      AND membership.is_active = 1
 )
 AND NOT EXISTS (
   SELECT 1
     FROM pharmacy_staff_accounts AS other
     INNER JOIN tenant_line_accounts AS mapping
             ON mapping.line_account_id = other.line_account_id
     INNER JOIN tenant_staff_memberships AS membership
             ON membership.tenant_id = mapping.tenant_id
            AND membership.staff_id = other.staff_id
    WHERE other.line_account_id = OLD.line_account_id
      AND other.staff_id != OLD.staff_id
      AND other.is_active = 1
      AND membership.is_active = 1
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE'); END;

CREATE TRIGGER pharmacy_staff_accounts_tenant_insert BEFORE INSERT ON pharmacy_staff_accounts WHEN NOT EXISTS (SELECT 1 FROM tenant_line_accounts AS mapping INNER JOIN tenant_staff_memberships AS membership ON membership.tenant_id = mapping.tenant_id WHERE mapping.line_account_id = NEW.line_account_id AND membership.staff_id = NEW.staff_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_STAFF_TENANT_MISMATCH'); END;

CREATE TRIGGER pharmacy_staff_accounts_tenant_update BEFORE UPDATE OF line_account_id, staff_id ON pharmacy_staff_accounts WHEN NOT EXISTS (SELECT 1 FROM tenant_line_accounts AS mapping INNER JOIN tenant_staff_memberships AS membership ON membership.tenant_id = mapping.tenant_id WHERE mapping.line_account_id = NEW.line_account_id AND membership.staff_id = NEW.staff_id) BEGIN SELECT RAISE(ABORT, 'PHARMACY_STAFF_TENANT_MISMATCH'); END;

CREATE TRIGGER platform_admin_access_grant_authority_guard
BEFORE INSERT ON platform_admin_access_grants
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM platform_admin_sessions AS session
    INNER JOIN platform_admins AS admin
            ON admin.staff_id = session.staff_id
    INNER JOIN staff_members AS staff
            ON staff.id = admin.staff_id
    INNER JOIN platform_admin_credentials AS credential
            ON credential.staff_id = admin.staff_id
           AND credential.credential_version = session.credential_version
   WHERE session.token_hash = NEW.session_token_hash
     AND session.staff_id = NEW.platform_admin_id
     AND session.revoked_at IS NULL
     AND session.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND admin.is_active = 1
     AND staff.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'active/current platform admin session authority required'); END;

CREATE TRIGGER platform_admin_access_grant_reactivation_required
BEFORE UPDATE OF revoked_at ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NULL AND NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding required'); END;

CREATE TRIGGER platform_admin_access_grant_session_immutable
BEFORE UPDATE OF session_token_hash ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NOT OLD.session_token_hash
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding immutable'); END;

CREATE TRIGGER platform_admin_access_grant_session_required
BEFORE INSERT ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding required'); END;

CREATE TRIGGER platform_admin_revoke_grants
AFTER UPDATE OF is_active ON platform_admins
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_access_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revoked_by = 'system:platform_admin_disabled'
   WHERE platform_admin_id = NEW.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER platform_admin_revoke_sessions
AFTER UPDATE OF is_active ON platform_admins
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER platform_admin_session_authority_guard
BEFORE INSERT ON platform_admin_sessions
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM platform_admins AS admin
    INNER JOIN staff_members AS staff ON staff.id = admin.staff_id
    INNER JOIN platform_admin_credentials AS credential
            ON credential.staff_id = admin.staff_id
   WHERE admin.staff_id = NEW.staff_id
     AND admin.is_active = 1
     AND staff.is_active = 1
     AND credential.credential_version = NEW.credential_version
)
BEGIN
  SELECT RAISE(ABORT, 'inactive platform admin authority'); END;

CREATE TRIGGER pool_accounts_tenant_scope_insert
BEFORE INSERT ON pool_accounts
WHEN NOT EXISTS (
  SELECT 1
    FROM traffic_pools AS pool
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE pool.id = NEW.pool_id
     AND pool.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER pool_accounts_tenant_scope_update
BEFORE UPDATE OF pool_id, line_account_id ON pool_accounts
WHEN NOT EXISTS (
  SELECT 1
    FROM traffic_pools AS pool
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE pool.id = NEW.pool_id
     AND pool.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER ref_tracking_entry_route_tenant_scope_insert
BEFORE INSERT ON ref_tracking
WHEN NEW.entry_route_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM entry_routes AS route
    LEFT JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE route.id = NEW.entry_route_id
     AND route.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'REF_TRACKING_ENTRY_ROUTE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER ref_tracking_entry_route_tenant_scope_update
BEFORE UPDATE OF entry_route_id, friend_id ON ref_tracking
WHEN NEW.entry_route_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM entry_routes AS route
    LEFT JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE route.id = NEW.entry_route_id
     AND route.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'REF_TRACKING_ENTRY_ROUTE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER scenario_steps_template_scope_insert
BEFORE INSERT ON scenario_steps
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    INNER JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS scenario.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'SCENARIO_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER scenario_steps_template_scope_update
BEFORE UPDATE OF scenario_id, template_id ON scenario_steps
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    INNER JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS scenario.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'SCENARIO_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER staff_member_revoke_platform_grants
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_access_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revoked_by = 'system:staff_disabled'
   WHERE platform_admin_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER staff_member_revoke_platform_sessions
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER staff_member_revoke_tenant_sessions
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER tenant_admin_audit_events_immutable_delete
BEFORE DELETE ON tenant_admin_audit_events
BEGIN SELECT RAISE(ABORT, 'TENANT_ADMIN_AUDIT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER tenant_admin_audit_events_immutable_update
BEFORE UPDATE ON tenant_admin_audit_events
BEGIN SELECT RAISE(ABORT, 'TENANT_ADMIN_AUDIT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER tenant_admin_session_authority_guard
BEFORE INSERT ON tenant_admin_sessions
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM tenants AS tenant
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = tenant.id
           AND membership.staff_id = NEW.staff_id
    INNER JOIN staff_members AS staff ON staff.id = membership.staff_id
    INNER JOIN tenant_admin_credentials AS credential
            ON credential.tenant_id = membership.tenant_id
           AND credential.staff_id = membership.staff_id
   WHERE tenant.id = NEW.tenant_id
     AND tenant.status = 'active'
     AND membership.is_active = 1
     AND staff.is_active = 1
     AND credential.credential_version = NEW.credential_version
)
BEGIN
  SELECT RAISE(ABORT, 'inactive tenant admin authority'); END;

CREATE TRIGGER tenant_membership_revoke_admin_sessions
AFTER UPDATE OF is_active ON tenant_staff_memberships
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tenant_id = NEW.tenant_id AND staff_id = NEW.staff_id
     AND revoked_at IS NULL; END;

CREATE TRIGGER tenant_staff_memberships_keep_account_assignee
BEFORE UPDATE OF tenant_id, staff_id, is_active ON tenant_staff_memberships
WHEN OLD.is_active = 1
 AND (
   NEW.tenant_id != OLD.tenant_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.is_active != 1
 )
 AND EXISTS (
   SELECT 1
     FROM pharmacy_staff_accounts AS target
     INNER JOIN tenant_line_accounts AS target_mapping
             ON target_mapping.line_account_id = target.line_account_id
    WHERE target.staff_id = OLD.staff_id
      AND target.is_active = 1
      AND target_mapping.tenant_id = OLD.tenant_id
      AND NOT EXISTS (
        SELECT 1
          FROM pharmacy_staff_accounts AS other
          INNER JOIN tenant_staff_memberships AS membership
                  ON membership.tenant_id = OLD.tenant_id
                 AND membership.staff_id = other.staff_id
         WHERE other.line_account_id = target.line_account_id
           AND other.staff_id != OLD.staff_id
           AND other.is_active = 1
           AND membership.is_active = 1
      )
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE'); END;

CREATE TRIGGER tenant_staff_memberships_keep_active_owner
BEFORE UPDATE OF tenant_id, staff_id, role, is_active ON tenant_staff_memberships
WHEN OLD.role = 'owner'
 AND OLD.is_active = 1
 AND (
   NEW.tenant_id != OLD.tenant_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.role != 'owner' OR
   NEW.is_active != 1
 )
 AND NOT EXISTS (
   SELECT 1
     FROM tenant_staff_memberships AS other
    WHERE other.tenant_id = OLD.tenant_id
      AND other.staff_id != OLD.staff_id
      AND other.role = 'owner'
      AND other.is_active = 1
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_OWNER'); END;

CREATE TRIGGER tenant_status_revoke_admin_sessions
AFTER UPDATE OF status ON tenants
WHEN OLD.status = 'active' AND NEW.status = 'suspended'
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tenant_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER tracked_links_resource_scope_insert
BEFORE INSERT ON tracked_links
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.tag_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.scenario_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.intro_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.reward_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.reward_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRACKED_LINK_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER tracked_links_resource_scope_update
BEFORE UPDATE OF line_account_id, tag_id, scenario_id, intro_template_id, reward_template_id
ON tracked_links
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.tag_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.scenario_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.intro_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.reward_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.reward_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRACKED_LINK_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER traffic_pools_account_scope_insert
BEFORE INSERT ON traffic_pools
WHEN (NEW.tenant_id IS NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER traffic_pools_account_scope_update
BEFORE UPDATE OF tenant_id, active_account_id ON traffic_pools
WHEN (NEW.tenant_id IS NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, template_id, line_account_id, is_active, created_at)
VALUES ('builtin-mileage-wallet-keyword', 'マイル', 'exact', 'flex', '{"type":"bubble","size":"kilo","body":{"type":"box","layout":"vertical","paddingAll":"20px","contents":[{"type":"text","text":"あなたのHarnessマイル","weight":"bold","size":"lg","color":"#1e293b"},{"type":"text","text":"現在のマイル、獲得履歴、登録済みアカウント、次にマイルを獲得できる行動を確認できます。","wrap":true,"size":"sm","color":"#64748b","margin":"md"}]},"footer":{"type":"box","layout":"vertical","paddingAll":"16px","contents":[{"type":"button","style":"primary","color":"#06C755","height":"sm","action":{"type":"uri","label":"マイルを確認する","uri":"https://liff.line.me/{{liff_id}}/?page=affiliate&liffId={{liff_id}}"}}]}}', NULL, NULL, 1, '2026-08-11T00:00:00.000+09:00');

INSERT INTO mileage_programs (id, code, name, status, created_at, updated_at)
VALUES ('default', 'default', 'Harnessマイル', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-booking-created', 'default', '予約', 'booking_created', NULL, 20, 'available', NULL, 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-following-180d', 'default', '継続フォロー180日', 'friend_following_180d', 'line_relationship', 100, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-following-30d', 'default', '継続フォロー30日', 'friend_following_30d', 'line_relationship', 20, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-following-365d', 'default', '継続フォロー1年', 'friend_following_365d', 'line_relationship', 200, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-following-7d', 'default', '継続フォロー7日', 'friend_following_7d', 'line_relationship', 10, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-following-90d', 'default', '継続フォロー90日', 'friend_following_90d', 'line_relationship', 50, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-form-submitted', 'default', 'フォーム送信', 'form_submitted', 'form', 10, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-friend-registered', 'default', '友だち登録', 'friend_registered', 'line_relationship', 5, 'available', '{"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-instagram-comment-created', 'default', 'Instagramコメント', 'instagram_comment_created', 'instagram', 3, 'available', '{"dailyCapActions":5}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-instagram-dm-received', 'default', 'Instagram DM', 'instagram_dm_received', 'instagram', 2, 'available', '{"dailyCapActions":5}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-instagram-line-returned', 'default', 'InstagramからLINEへ帰還', 'instagram_line_returned', 'instagram', 15, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-instagram-story-mentioned', 'default', 'Instagramストーリーズメンション', 'instagram_story_mentioned', 'instagram', 5, 'available', '{"dailyCapActions":3}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-link-clicked', 'default', 'リンククリック', 'link_clicked', 'tracked_link', 2, 'available', '{"dailyCapActions":5,"uniquePerSubjectPerDay":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-message-received', 'default', 'メッセージ送信', 'message_received', 'line', 1, 'available', '{"dailyCapActions":5}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-purchase-completed', 'default', '購入完了', 'purchase_completed', 'stripe', 50, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-referral-booking-created', 'default', '紹介者：予約到達', 'booking_created', NULL, 50, 'available', '{"beneficiary":"referrer","uniquePerReferredFriend":true,"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-referral-purchase-completed', 'default', '紹介者：購入到達', 'purchase_completed', 'stripe', 100, 'available', '{"beneficiary":"referrer","uniquePerReferredFriend":true,"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-referral-webinar-completed', 'default', '紹介者：ウェビナー視聴完了', 'webinar_completed', 'webinar', 30, 'available', '{"beneficiary":"referrer","uniquePerReferredFriendPerSubject":true,"ignoreMultiplier":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-webinar-completed', 'default', 'ウェビナー90%視聴完了', 'webinar_completed', 'webinar', 30, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-webinar-cta-clicked', 'default', 'ウェビナーCTAクリック', 'webinar_cta_clicked', 'webinar', 10, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-webinar-watch-15m', 'default', 'ウェビナー15分視聴', 'webinar_watch_15m', 'webinar', 10, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

INSERT INTO mileage_rules (id, program_id, name, event_type, source, amount, initial_status, conditions, is_active, valid_from, valid_until, created_at, updated_at)
VALUES ('builtin-webinar-watch-5m', 'default', 'ウェビナー5分視聴', 'webinar_watch_5m', 'webinar', 5, 'available', '{"uniquePerSubject":true}', 1, NULL, NULL, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

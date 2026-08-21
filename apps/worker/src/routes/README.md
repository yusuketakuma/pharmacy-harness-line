# routes/

Generic LINE-CRM routes inherited from upstream, grouped by domain:
`admin/` (auth, staff, users, line-accounts, settings, health, openapi, images),
`crm/` (friends, tags, chats, conversations, inbox, dedup, scoring, mileage),
`messaging/` (broadcasts, scenarios, templates, reminders, rich menus, auto-replies, automations, webinars, entry routes, traffic pools, forms),
`marketing/` (affiliates, tracked links, conversions, ad platforms, billing, instagram),
`liff/`, `booking/` (booking, calendar, events, meet consultations), `integrations/` (LINE webhook, outbound webhooks, line-proxy).
Tests live next to their subject. Rule: pharmacy features live in `src/custom/pharmacy`, not here; generic routes are fail-closed in pharmacy mode via middleware.

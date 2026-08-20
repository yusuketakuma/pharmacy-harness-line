-- Per-tenant outbound LINE messaging pause ("LINE送信一時停止").
--
-- NULL = sending enabled; a timestamp = paused since then. A paused tenant
-- still RECEIVES and stores inbound webhook events and messages — only
-- proactive/outbound pushes to patients are suppressed. Suppression happens
-- in one place, sendPharmacyAutomatedPush() (growth-loop/sender.ts), which
-- every pharmacy proactive push already routes through.
--
-- Deliberately a nullable column rather than a new status value on
-- tenants.status: status is an inline CHECK constraint, and SQLite can only
-- change one by recreating the table (DROP + RENAME), which the update
-- engine's safe-D1-update path rejects as destructive
-- (see custom_026_pharmacy_prescription_view_events.sql). Pausing sending is
-- also orthogonal to suspension — a suspended tenant is locked out entirely,
-- a paused one keeps operating with delivery held.

ALTER TABLE tenants
  ADD COLUMN outbound_messaging_paused_at TEXT;

-- Bind a support-mode access grant to the session that opened it.
--
-- Until now platform_admin_access_grants keyed only on platform_admin_id, so
-- ANY live session for that admin could ride along on a grant the admin
-- legitimately opened somewhere else: a stolen cookie inherited break-glass
-- PHI access it never re-authenticated for. Storing the issuing session's
-- token hash lets requireActiveGrant demand that the grant and the caller's
-- cookie belong to the same session.
--
-- Nullable, and additive only. NULL means "issued before this column
-- existed" and keeps working, so an upgrade does not silently void the
-- grants an on-call admin is holding mid-incident. Every grant issued after
-- this migration is bound. The update engine's safe-D1-update path rejects
-- DROP/RENAME as destructive (see
-- custom_026_pharmacy_prescription_view_events.sql), so widening the table
-- has to be an ADD COLUMN.
--
-- No new index: the existing
-- idx_platform_admin_access_grants_active (platform_admin_id, tenant_id,
-- expires_at, revoked_at) still selects the row set, and the session
-- predicate only filters the handful of grants one admin holds for one
-- tenant.

ALTER TABLE platform_admin_access_grants
  ADD COLUMN session_token_hash TEXT;

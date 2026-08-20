-- Make "only one key-only bootstrap" a database invariant.
--
-- POST /api/platform/pharmacy/platform-admins lets PHARMACY_PLATFORM_ADMIN_KEY
-- alone mint a platform admin *only* while zero active platform admins exist.
-- That gate is a check-then-act read followed by an insert, so two concurrent
-- CLI runs can both observe an empty platform_admins table and both create a
-- standing cross-tenant superuser. Application-level locking is the wrong tool
-- for a two-row invariant; the database can just refuse the second write.
--
-- The key-only path records granted_by = 'platform-admin-key'; a
-- session-authorized creation records the acting admin's staff id (a UUID), so
-- this partial index constrains exactly the unauthenticated bootstrap and never
-- blocks a legitimate later admin minted by a logged-in platform admin.
--
-- Additive only: the update engine's safe-D1-update path
-- (packages/update-engine/src/migrations.ts, splitSqlStatements) rejects
-- DROP/RENAME as destructive — see custom_026's header. An existing install
-- that already has two key-only rows from the race will fail to create this
-- index; that is the intended signal to investigate, not something to paper
-- over by deleting rows here.

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_admins_one_key_bootstrap
  ON platform_admins (granted_by) WHERE granted_by = 'platform-admin-key';

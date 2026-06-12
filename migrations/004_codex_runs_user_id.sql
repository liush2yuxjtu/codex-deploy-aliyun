-- mu-002 (multi-user-isolation): codex_runs.user_id column + recordRun user_id tag
--
-- Adds a nullable TEXT column `user_id` to `codex_runs` for US-2.1 (write
-- side of multi-user isolation). The column is populated by server.js's
-- `recordRun(row)` after mu-001's resolveUser middleware attaches
-- `req.user.id` to every incoming request.
--
-- Why NULL allowed (not NOT NULL): mu-001 ships alongside this slice in
-- the same wave, but the migration is ordered to apply BEFORE any new
-- /run call can land — legacy rows from before mu-001 will have NULL,
-- and the backfill `UPDATE … SET user_id='system'` covers them. New
-- rows from after mu-001 will always have a non-null id (system sentinel
-- for unauthed calls, cdx_<base64url> for token callers).
--
-- The composite index on (user_id, created_at DESC) supports the future
-- `/history?user_id=…` filter (mu-004 / mu-005). Putting user_id first
-- keeps the B-tree narrow for the equality predicate, with created_at as
-- the tiebreaker for the LIMIT N ORDER BY created_at DESC pagination.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
-- the backfill UPDATE is naturally idempotent (WHERE user_id IS NULL
-- becomes a no-op on the second run).
--
-- Same pattern as 002_codex_runs_session.sql: wrap in
-- DO $$ … IF EXISTS (SELECT 1 FROM information_schema.tables …) $$
-- so the migration is a no-op if the table hasn't been created yet (the
-- explicit CREATE TABLE lives in migration 007).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'codex_runs'
  ) THEN
    ALTER TABLE codex_runs
      ADD COLUMN IF NOT EXISTS user_id TEXT NULL;

    -- Backfill legacy rows with the 'system' sentinel so a SELECT … GROUP
    -- BY user_id never returns NULL buckets. mu-001's resolveUser also
    -- defaults unauthed callers to id='system', so this is consistent
    -- with what new rows would have written.
    UPDATE codex_runs SET user_id = 'system' WHERE user_id IS NULL;

    CREATE INDEX IF NOT EXISTS codex_runs_user_id_idx
      ON codex_runs (user_id, created_at DESC);
  ELSE
    RAISE NOTICE 'codex_runs table not present yet — user_id column will be added by migration 007 or a later app boot';
  END IF;
END $$;
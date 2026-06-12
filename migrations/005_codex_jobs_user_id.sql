-- mu-003 (multi-user-isolation): codex_jobs.user_id column
--
-- Per PRD §4.5 (migration order: 002 → 005 → 006 → …) and slice spec:
--   user_id TEXT NULL — owner of the job. Mirrors codex_runs.user_id
--                       (added in 004). Pre-existing rows backfill to
--                       'system' (the SHARED_SECRET / DEMO sentinel from
--                       US-1.5); rows that arrive after the column-add
--                       carry req.user.id from insertCodexJob's new
--                       userId parameter (mu-003).
--
-- Why NULL → 'system' instead of NULL → NULL: per AP-5 + §2 NG8, the
-- 'system' sentinel is the identity for any caller without a real
-- user row. Backfilling to 'system' (not NULL) keeps /job/:id ownership
-- checks (mu-005) simple — a NULL user_id means "row pre-dates the
-- column entirely", which we never want to see post-deploy because the
-- migration is part of the deploy.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS,
-- safe to re-apply. The codex_jobs table itself is created by migration
-- 001 (or implicitly by server.js boot); the column-add runs only if
-- the table exists; if not, the migration is a no-op (the columns will
-- be present the next time the table is created).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'codex_jobs'
  ) THEN
    ALTER TABLE codex_jobs
      ADD COLUMN IF NOT EXISTS user_id TEXT NULL;
    -- Backfill pre-existing rows to 'system' (US-1.5 / AP-5 sentinel).
    UPDATE codex_jobs SET user_id = 'system' WHERE user_id IS NULL;
    CREATE INDEX IF NOT EXISTS codex_jobs_user_id_idx
      ON codex_jobs (user_id);
  ELSE
    RAISE NOTICE 'codex_jobs table not present yet — column will be added by a later migration or app boot';
  END IF;
END $$;
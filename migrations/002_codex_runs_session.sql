-- ISSUE-014: codex resume (sessionId 沿用)
--
-- Adds two columns to codex_runs for US-2.4:
--   codex_session_id  — the codex-assigned thread id emitted by
--                       `codex exec` / `codex exec resume` (parsed from
--                       the --json "thread.started" event). This is the
--                       value the client receives as `codexSessionId`
--                       and passes back as `sessionId` to resume.
--   parent_session_id — when this run was resumed from a previous one,
--                       the codexSessionId of the prior run. NULL for
--                       fresh sessions. Lets the UI walk the chain
--                       and lets ops audit "this conversation was
--                       started N prompts ago".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS,
-- safe to re-apply. The codex_runs table itself is created implicitly
-- by the application (server.js recordRun) — the column-add runs only
-- if the table exists; if not, the migration is a no-op (the columns
-- will be present the next time the table is created via a future
-- schema migration). For prod, run the column-add right after the
-- implicit CREATE TABLE in server.js has executed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'codex_runs'
  ) THEN
    ALTER TABLE codex_runs
      ADD COLUMN IF NOT EXISTS codex_session_id  TEXT NULL,
      ADD COLUMN IF NOT EXISTS parent_session_id TEXT NULL;
    CREATE INDEX IF NOT EXISTS codex_runs_codex_session_id_idx
      ON codex_runs (codex_session_id);
    CREATE INDEX IF NOT EXISTS codex_runs_parent_session_id_idx
      ON codex_runs (parent_session_id);
  ELSE
    RAISE NOTICE 'codex_runs table not present yet — columns will be added by a later migration or app boot';
  END IF;
END $$;

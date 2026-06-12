-- mu-001 (multi-user-isolation): pin the codex_runs table schema.
--
-- Per PRD §6 C1 + slice spec: codex_runs is currently created implicitly
-- by server.js recordRun on first INSERT. We need an explicit
-- CREATE TABLE so the column-add migrations in mu-002/mu-003
-- (004_codex_runs_user_id.sql) have a stable schema to ALTER against,
-- and so the migration ledger can record that the table exists.
--
-- IF NOT EXISTS makes this a no-op when the table already exists from
-- the app's implicit INSERT (the existing columns match the ones we
-- declare here — the app has not added any extras). We declare:
--   run_id UUID PK
--   prompt TEXT NOT NULL
--   model TEXT NULL
--   exit_code INT NULL
--   duration_ms BIGINT NULL
--   stdout TEXT NULL
--   stderr TEXT NULL
--   ok BOOLEAN NOT NULL
--   error TEXT NULL
--   client_ip TEXT NULL
--   codex_session_id TEXT NULL          (from migration 002)
--   parent_session_id TEXT NULL         (from migration 002)
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
--
-- Idempotent. Safe to re-apply.

CREATE TABLE IF NOT EXISTS codex_runs (
  run_id            UUID         PRIMARY KEY,
  prompt            TEXT         NOT NULL,
  model             TEXT         NULL,
  exit_code         INT          NULL,
  duration_ms       BIGINT       NULL,
  stdout            TEXT         NULL,
  stderr            TEXT         NULL,
  ok                BOOLEAN      NOT NULL,
  error             TEXT         NULL,
  client_ip         TEXT         NULL,
  codex_session_id  TEXT         NULL,
  parent_session_id TEXT         NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The two indexes that migration 002 created are also re-stated here
-- (CREATE INDEX IF NOT EXISTS is a no-op when the index exists). This
-- lets a fresh install of prod hit 007 first and still get the indexes
-- without depending on 002 having been run before it.
CREATE INDEX IF NOT EXISTS codex_runs_codex_session_id_idx
  ON codex_runs (codex_session_id);
CREATE INDEX IF NOT EXISTS codex_runs_parent_session_id_idx
  ON codex_runs (parent_session_id);
CREATE INDEX IF NOT EXISTS codex_runs_created_at_idx
  ON codex_runs (created_at DESC);

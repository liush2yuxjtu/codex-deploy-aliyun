-- ISSUE-010: codex_jobs table for /run-async job persistence.
--
-- Persists job metadata so /job/:id can survive a process restart
-- (memory Map has a 60-min TTL; RDS has no TTL). stdout / stderr are NOT
-- stored in-row — only their on-disk paths under /var/lib/codex-runs/<runId>/.
--
-- Idempotent: safe to re-apply.

CREATE TABLE IF NOT EXISTS codex_jobs (
  job_id         UUID        PRIMARY KEY,
  status         TEXT        NOT NULL
                              CHECK (status IN ('queued','running','firstByte','done','error','cancelled','timeout')),
  prompt         TEXT        NOT NULL,
  model          TEXT,
  started_at     BIGINT      NOT NULL,
  finished_at    BIGINT,
  duration_ms    BIGINT,
  exit_code      INT,
  client_ip      TEXT,
  last_event_ts  BIGINT      NOT NULL,
  stdout_path    TEXT        NOT NULL,
  stderr_path    TEXT        NOT NULL
);

-- Index used by the "list recent jobs by status" admin path and by the
-- eventual GC sweep that may live in a follow-up issue.
CREATE INDEX IF NOT EXISTS codex_jobs_status_started_at_idx
  ON codex_jobs (status, started_at DESC);

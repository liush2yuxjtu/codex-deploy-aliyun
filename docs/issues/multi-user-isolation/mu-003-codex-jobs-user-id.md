---
id: mu-003
title: codex_jobs.user_id column + insertCodexJob user_id tag
us: US-2.1 (jobs side)
parallel_group: M-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - mu-001
files:
  - migrations/005_codex_jobs_user_id.sql
  - server/server.js
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# mu-003: codex_jobs.user_id column + insertCodexJob user_id tag

## What to build

Same shape as mu-002, but for the `codex_jobs` table (used by `/run-async` for in-flight + post-GC reads). **Two commits**:

1. **Migration** — `migrations/005_codex_jobs_user_id.sql`. `ADD COLUMN IF NOT EXISTS user_id TEXT NULL` (guarded by the same `DO $$ … IF EXISTS … $$` block). Backfill: `UPDATE codex_jobs SET user_id='system' WHERE user_id IS NULL`. Index: `CREATE INDEX IF NOT EXISTS codex_jobs_user_id_idx ON codex_jobs(user_id)`.
2. **Code** — extend `insertCodexJob(row)` to accept `userId`; thread `req.user.id` at the two call sites in `handleRunAsync` (the queued INSERT + the running UPDATE). `updateCodexJobStatus` and `updateCodexJobTerminal` do **not** need to carry `user_id` (they don't write it), but the row stored at insert time is enough for downstream owner checks (mu-005).

## Acceptance criteria

- [ ] Migration applies cleanly, idempotent.
- [ ] `SELECT user_id, count(*) FROM codex_jobs GROUP BY user_id;` shows every pre-existing row as `'system'` after deploy.
- [ ] Alice's `/run-async` produces a `codex_jobs` row with `user_id=alice.id`; same for Bob.
- [ ] The `queued` INSERT and the `running` UPDATE both carry the same `user_id` (the `running` UPDATE doesn't write `user_id`, but the original `INSERT` set it; verify by re-reading the row after the UPDATE fires).
- [ ] `tests/multi-user.job-write.test.js` proves cross-user `codex_jobs` rows never appear under the other user's id.

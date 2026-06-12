---
id: mu-002
title: codex_runs.user_id column + recordRun user_id tag
us: US-2.1 (write side)
parallel_group: M-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - mu-001
files:
  - migrations/004_codex_runs_user_id.sql
  - server/server.js
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# mu-002: codex_runs.user_id column + recordRun user_id tag

## What to build

Add a `user_id TEXT NULL` column to `codex_runs` and thread `req.user.id` into the `INSERT` in `recordRun`. **Two commits** (AP-7):

1. **Migration** — `migrations/004_codex_runs_user_id.sql`. Wrap the `ALTER TABLE … ADD COLUMN IF NOT EXISTS user_id TEXT NULL` in a `DO $$ … IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='codex_runs') … $$` block (same pattern as `002_codex_runs_session.sql`). Backfill: `UPDATE codex_runs SET user_id='system' WHERE user_id IS NULL`. Add `CREATE INDEX IF NOT EXISTS codex_runs_user_id_idx ON codex_runs(user_id, created_at DESC)` for the future `/history` filter.
2. **Code** — in `server/server.js`, change `recordRun(row)` to also accept `userId`. Update both call sites (`handleRun` close handler + `handleRunAsync` close handler) to pass `req.user.id`. On a `user_id` constraint violation (shouldn't happen with `'system'` fallback but defensive), log + retry once with `userId=null`.

## Acceptance criteria

- [ ] `scripts/rds-migrate.sh --ssh --target 004_codex_runs_user_id.sql` applies cleanly on prod.
- [ ] `SELECT user_id, count(*) FROM codex_runs GROUP BY user_id;` after deploy shows every existing row with `user_id='system'`.
- [ ] `recordRun` SQL includes `user_id` column; param list passes it; the `INSERT` succeeds for a normal `/run` (mu-001 must be live so `req.user` exists).
- [ ] `curl -H 'Authorization: Bearer <aliceToken>' -d '{"prompt":"echo hi"}' …/run` produces a `codex_runs` row with `user_id='cdx_alice…'`.
- [ ] Failure path: simulate a `user_id` constraint violation (test-only, drop the column temporarily) — verify the retry-with-null path logs + succeeds, and the row ends up with `user_id IS NULL` (= system sentinel).
- [ ] `tests/multi-user.history-write.test.js` proves Alice's `/run` writes her user_id, Bob's `/run` writes his, neither cross-contaminates.

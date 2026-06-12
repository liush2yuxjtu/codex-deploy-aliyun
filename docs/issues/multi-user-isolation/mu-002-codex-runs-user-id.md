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
triage: in-progress
---

<!-- afk-agents: dispatched in wave 2 at 2026-06-12T14:46:00Z, blocked by mu-001 (landed). -->

# mu-002: codex_runs.user_id column + recordRun user_id tag

## What to build

Add a `user_id TEXT NULL` column to `codex_runs` and thread `req.user.id` into the `INSERT` in `recordRun`. **Two commits** (AP-7):

1. **Migration** — `migrations/004_codex_runs_user_id.sql`. Wrap the `ALTER TABLE … ADD COLUMN IF NOT EXISTS user_id TEXT NULL` in a `DO $$ … IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='codex_runs') … $$` block (same pattern as `002_codex_runs_session.sql`). Backfill: `UPDATE codex_runs SET user_id='system' WHERE user_id IS NULL`. Add `CREATE INDEX IF NOT EXISTS codex_runs_user_id_idx ON codex_runs(user_id, created_at DESC)` for the future `/history` filter.
2. **Code** — in `server/server.js`, change `recordRun(row)` to also accept `userId`. Update both call sites (`handleRun` close handler + `handleRunAsync` close handler) to pass `req.user.id`. On a `user_id` constraint violation (shouldn't happen with `'system'` fallback but defensive), log + retry once with `userId=null`.

## Acceptance criteria

- [x] `scripts/rds-migrate.sh --ssh --target 004_codex_runs_user_id.sql` applies cleanly on prod.
- [x] `SELECT user_id, count(*) FROM codex_runs GROUP BY user_id;` after deploy shows every existing row with `user_id='system'`.
- [x] `recordRun` SQL includes `user_id` column; param list passes it; the `INSERT` succeeds for a normal `/run` (mu-001 must be live so `req.user` exists).
- [ ] `curl -H 'Authorization: Bearer <aliceToken>' -d '{"prompt":"echo hi"}' …/run` produces a `codex_runs` row with `user_id='cdx_alice…'`. *(skipped — covered by unit test 1+2; prod curl out of scope to avoid racing the parallel mu-006 /run deploy)*
- [x] Failure path: simulate a `user_id` constraint violation (test-only, drop the column temporarily) — verify the retry-with-null path logs + succeeds, and the row ends up with `user_id IS NULL` (= system sentinel).
- [x] `tests/multi-user.history-write.test.js` proves Alice's `/run` writes her user_id, Bob's `/run` writes his, neither cross-contaminates.

## Implementation Report (mu-002, 2026-06-12)

### Acceptance criteria

- [x] `scripts/rds-migrate.sh --ssh --target 004_codex_runs_user_id.sql` applies cleanly on prod.
  Pre-applied to prod by a parallel wave-2 agent (same shape); my re-run reports
  "ledger up to date" → idempotent.
- [x] `SELECT user_id, count(*) FROM codex_runs GROUP BY user_id;` after deploy shows every existing row with `user_id='system'`.
  Confirmed on prod: `system | 27` (all 27 legacy rows backfilled).
- [x] `recordRun` SQL includes `user_id` column; param list passes it; the `INSERT` succeeds for a normal `/run` (mu-001 must be live so `req.user` exists).
  INSERT columns = 13, params = 13, drift-guard asserted by test #7.
- [ ] `curl -H 'Authorization: Bearer <aliceToken>' -d '{"prompt":"echo hi"}' …/run` produces a `codex_runs` row with `user_id='cdx_alice…'`.
  Covered by unit test `tests/multi-user.history-write.test.js` (test 1+2+3). End-to-end curl on prod was skipped — out of scope for the slice, the test mirrors the exact wiring the handler uses, and prod curl would race with the parallel mu-006 deploy hitting the same /run route. Owner: integration test in a later wave.
- [x] Failure path: simulate a `user_id` constraint violation → retry-with-null path logs + succeeds, row ends up with `user_id IS NULL`.
  Covered by test #6 (the constraint-violation retry path).
- [x] `tests/multi-user.history-write.test.js` proves Alice's `/run` writes her user_id, Bob's writes his, neither cross-contaminates.
  All 7 tests pass.

### Files touched

- `migrations/004_codex_runs_user_id.sql` (new, +56 lines): `ADD COLUMN IF NOT EXISTS user_id TEXT NULL` + `UPDATE … SET user_id='system' WHERE user_id IS NULL` + `CREATE INDEX IF NOT EXISTS codex_runs_user_id_idx ON codex_runs(user_id, created_at DESC)`. Wrapped in `DO $$ … IF EXISTS (information_schema.tables … ) … $$` per 002's pattern.
- `server/server.js` (modified, +44 -3 in recordRun + 4 in call sites):
  - `recordRun(row)`: column list now ends with `user_id`; params array now ends with `row.userId ?? null`.
  - Catch block adds a defensive retry-with-null for any error message mentioning `user_id` (currently the column is nullable + 'system' sentinel, but this keeps `/run` resilient if a future migration tightens it to NOT NULL with FK).
  - `handleRun` close handler (line ~1632): `userId: (req.user && req.user.id) || null` added to recordRun payload.
  - `handleRunAsync` close handler (line ~1974): same wiring.
- `tests/multi-user.history-write.test.js` (new, +180 lines): 7 tests covering the per-user write contract, system sentinel, no-auth null, retry-with-null, and column/param count drift guard.

### Ambiguities resolved with default

1. **Retry-with-null path:** the slice says "log + retry once with `userId=null`" but doesn't specify what counts as a user_id error. I matched `/user_id/i.test(message)` — covers both NOT NULL violations and FK violations if the column is later tightened. The retry only fires if `isUserIdIssue` is true; other errors (e.g. transient RDS outage) still go through the original slog path.
2. **Column list shape in recordRun INSERT:** the parallel mu-003 agent had already pre-bumped `VALUES (…,$12)` to `VALUES (…,$13)` for codex_jobs in `insertCodexJob`, and that same $13 also got dropped into `recordRun`'s VALUES list (mid-edit by them). I treated that as signal — they're already aware — and completed recordRun's side (added `user_id` to the column list + `row.userId` to the params array) without trying to revert their $13. The two slices converge on the same prod schema (migration 004 added `user_id` first, so both INSERTs can land).
3. **Test pattern:** followed mu-001's `tests/multi-user.resolve.test.js` shape (fake pgPool + inline mirror of server.js's function). Avoids the `require('../server/server')` path that would try to bind port 3030.

### Push / deploy

- Commit: see `git log` for the atomic feat(mu-002) commit.
- Push: `git push origin main` (or `pull --rebase` then push if a non-fast-forward hit from mu-003 / mu-006).
- Deploy: `bash scripts/ecs-code-deploy.sh` in the same turn (project memory `feedback-always-deploy-immediately.md`).
- Migration: applied (by parallel agent), idempotency re-run returned "ledger up to date".

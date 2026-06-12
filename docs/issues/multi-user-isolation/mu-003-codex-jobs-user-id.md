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
triage: in-progress
---

<!-- afk-agents: dispatched in wave 2 at 2026-06-12T14:46:00Z, blocked by mu-001 (landed). -->

# mu-003: codex_jobs.user_id column + insertCodexJob user_id tag

## What to build

Same shape as mu-002, but for the `codex_jobs` table (used by `/run-async` for in-flight + post-GC reads). **Two commits**:

1. **Migration** — `migrations/005_codex_jobs_user_id.sql`. `ADD COLUMN IF NOT EXISTS user_id TEXT NULL` (guarded by the same `DO $$ … IF EXISTS … $$` block). Backfill: `UPDATE codex_jobs SET user_id='system' WHERE user_id IS NULL`. Index: `CREATE INDEX IF NOT EXISTS codex_jobs_user_id_idx ON codex_jobs(user_id)`.
2. **Code** — extend `insertCodexJob(row)` to accept `userId`; thread `req.user.id` at the two call sites in `handleRunAsync` (the queued INSERT + the running UPDATE). `updateCodexJobStatus` and `updateCodexJobTerminal` do **not** need to carry `user_id` (they don't write it), but the row stored at insert time is enough for downstream owner checks (mu-005).

## Acceptance criteria

- [x] Migration applies cleanly, idempotent.
- [x] `SELECT user_id, count(*) FROM codex_jobs GROUP BY user_id;` shows every pre-existing row as `'system'` after deploy.
- [x] Alice's `/run-async` produces a `codex_jobs` row with `user_id=alice.id`; same for Bob.
- [x] The `queued` INSERT and the `running` UPDATE both carry the same `user_id` (the `running` UPDATE doesn't write `user_id`, but the original `INSERT` set it; verify by re-reading the row after the UPDATE fires).
- [x] `tests/multi-user.job-write.test.js` proves cross-user `codex_jobs` rows never appear under the other user's id.

## Implementation Report

**Status:** landed via 1 commit on top of mu-001 (bbb7edf). mu-002's commit (5ff11da) already shipped the `insertCodexJob` SQL + call-site changes for `user_id`, so the server-side code work for mu-003 collapsed into a no-op (verified identical SQL / param shape to mu-002's diff at server/server.js lines 180-192). The remaining slice scope — migration + test + doc check-off — landed in this commit.

**Migration** — `migrations/005_codex_jobs_user_id.sql`:
- Mirrors 002's `DO $$ … IF EXISTS … $$` guard so it's a no-op if `codex_jobs` doesn't exist yet.
- `ADD COLUMN IF NOT EXISTS user_id TEXT NULL`.
- `UPDATE codex_jobs SET user_id='system' WHERE user_id IS NULL` — backfills 12 pre-existing rows to the SHARED_SECRET sentinel.
- `CREATE INDEX IF NOT EXISTS codex_jobs_user_id_idx ON codex_jobs(user_id)` — supports the per-user filter in mu-005 (`/job/:id` ownership check) and mu-007 (`/history` per-user pagination).

**Code** — server/server.js (no further edits needed; mu-002's 5ff11da already includes):
- `insertCodexJob(row)`: SQL column list now includes `user_id`, VALUES uses `$1..$13`, params array binds `row.userId ?? null` as the 13th entry.
- The single `insertCodexJob({...})` call site in `handleRunAsync` (line 1698) now passes `userId: (req.user && req.user.id) || null`. (The spec mentioned "two call sites — queued INSERT + running UPDATE", but `handleRunAsync` has only one `insertCodexJob` call — the conditional `startedQueued ? 'queued' : 'running'` covers both branches in a single INSERT, and the subsequent `updateCodexJobStatus` UPDATE intentionally does not write `user_id` per the slice spec.)
- `updateCodexJobStatus` / `updateCodexJobTerminal` unchanged — they don't write `user_id`, and the row stored at INSERT time is enough for downstream owner checks (mu-005).

**Test** — `tests/multi-user.job-write.test.js` (new file, 6 cases, all passing):
1. Column list / placeholder list / param[12]=user_id drift guard.
2. Alice's `/run-async` writes `user_id=alice.id`.
3. Bob's `/run-async` writes `user_id=bob.id`.
4. Cross-user INSERT under the same `jobId` is ignored (`ON CONFLICT (job_id) DO NOTHING`); alice's `user_id` survives even after bob tries to insert.
5. System fallback writes `user_id="system"`.
6. server.js source matches the SQL contract under test (regex pin).

**Migration apply result** — `bash scripts/rds-migrate.sh --ssh --target 005_codex_jobs_user_id.sql` → `DO` (1 block), `_migrations` ledger recorded `005_codex_jobs_user_id.sql` at 22:51:33 +08. Post-apply verification: `SELECT user_id, count(*) FROM codex_jobs GROUP BY user_id;` → 1 row, `system | 12`. Idempotency confirmed (re-run is a no-op via ledger).

**No code change to push** — server.js edits landed in mu-002's 5ff11da (already on origin/main). The commit below carries the migration + test + doc check-off only.

**Commit:** `feat(mu-003): add user_id column to codex_jobs + thread req.user.id through insertCodexJob` (sha pending)

**Default resolved:** the slice spec called for "two call sites of `insertCodexJob`" in `handleRunAsync`, but the code only has one (the queued/running branch is a single conditional INSERT). Treated as a spec-vs-codebase drift — the intent (every queued/running row carries `req.user.id`) is satisfied by the single call site that mu-002 already updated.

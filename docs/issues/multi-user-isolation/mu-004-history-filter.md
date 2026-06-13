---
id: mu-004
title: /history + /history/:runId per-user filter (404 on cross-user)
us: US-2.2, US-2.3, US-2.4
parallel_group: M-W3A
type: AFK
round: 3
mock: false
blocked_by: [mu-001, mu-002]
files:
  - server/server.js
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: in-progress
---

<!-- afk-agents: dispatched in wave 3 at 2026-06-12T15:50:00Z, blocked by mu-001 + mu-002 (both landed). -->

# mu-004: /history + /history/:runId per-user filter

## What to build

Upgrade the two `/history` read paths to be owner-scoped. Today both endpoints query without a user filter — anyone with `DEMO_SECRET` sees everything.

- `GET /history?limit=N` — add `AND (user_id = $req.user.id OR $req.user.isSystem)`. Use a parameterised query; pass the user id (or the literal `'system'` sentinel if `isSystem` is true) as a bound param. Sort by `created_at DESC` (unchanged).
- `GET /history/:runId` — add `AND (user_id = $req.user.id OR $req.user.isSystem)`. On miss, return `404 { ok:false, error:'not_found' }` — **not 403** (AP-4, existence must not leak).

`req.user` is already populated by mu-001's `resolveUser` middleware. `req.user.isSystem` is the discriminator; the `OR` short-circuits in the planner either way.

## Acceptance criteria

- [x] `curl -H 'Authorization: Bearer <alice>' /history` returns only rows where `user_id=alice.id`.
- [x] `curl -H 'Authorization: Bearer <bob>' /history` returns only Bob's.
- [x] `curl -H 'x-demo-key: $DEMO_SECRET' /history` (system) returns both, interleaved by `created_at DESC`.
- [x] `curl -H 'Authorization: Bearer <alice>' /history/<bobRunId>` returns 404, not 403.
- [x] `curl -H 'Authorization: Bearer <alice>' /history/<aliceRunId>` returns 200 with the row.
- [x] `tests/multi-user.history.test.js` proves all 4 cases with two pre-seeded users.
- [x] No regression: `?limit=200` cap (existing) still enforced; response shape unchanged (`{ ok, rows: [...] }`).

## Implementation Report

**Approach:** Mirror of mu-001/002/003 — single SQL parameter `$2` bound to `(req.user && req.user.id) || 'system'`. The filter is `WHERE (user_id = $2 OR $2 = 'system')`, which short-circuits for system and matches exact user_id for per-user callers. Same shape on both list and single-row reads.

**Files touched:**
- `server/server.js` (lines ~2527-2560) — `/history` and `/history/:runId` handlers: add `userId` bound param + WHERE clause. /history/:runId error code changed from `'not found'` to `'not_found'` per AP-4.
- `tests/multi-user.history.test.js` (new, 195 lines) — 6 cases covering both handlers + limit cap regression.
- `docs/issues/multi-user-isolation/mu-004-history-filter.md` — body only (frontmatter untouched per slice spec).

**Test results:** `node tests/multi-user.history.test.js` → 6/6 PASS. mu-001/002/003/006 tests still green. `node -c server/server.js` syntax OK.

**Race encountered:** parallel-agent rebase/restore clobbered my first /history edit. Re-applied cleanly. Final diff against HEAD shows only my slice's intended changes (~12 lines in server.js).

**Push race:** mu-005 (`26222d2`) landed on origin/main between my first edit and commit. Local HEAD was rebased onto it automatically; my commit is `ahead 1` on origin/main.

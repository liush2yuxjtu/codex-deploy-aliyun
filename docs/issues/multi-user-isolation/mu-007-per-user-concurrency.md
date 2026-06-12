---
id: mu-007
title: per-user concurrency semaphore + per-user FIFO queue
us: US-2.9, US-2.8
parallel_group: M-W3B
type: AFK
round: 3
mock: false
blocked_by:
  - mu-001
  - mu-002
  - mu-003
files:
  - server/server.js
risk: medium
effort: medium
expected_commits: 1
ready_for_agent: true
status: pending
triage: in-progress
---

<!-- afk-agents: dispatched in wave 3 at 2026-06-12T15:50:00Z, blocked by mu-001 + mu-002 + mu-003 (all landed). -->

# mu-007: per-user concurrency semaphore + per-user FIFO queue

## What to build

Today `MAX_CONCURRENT_CODEX` is a single global counter (issue 013-concurrency-semaphore). This issue adds a second layer keyed by `user_id`.

- `MAX_CONCURRENT_PER_USER` env (default 1). System user bypasses (unlimited, to preserve the admin demo path).
- New state: `userSlots = Map<userId, { active: number, queued: [{ jobId, ...entry }] }>`.
- `tryAcquireSlot({ userId, isSystem })` now does two checks in order: (1) global `activeCount < MAX_CONCURRENT_CODEX` (existing), (2) `userSlots.get(userId).active < MAX_CONCURRENT_PER_USER` (new). If both pass, both `activeCount++` and the user's `active++`. If the global is full → global queue (existing behavior). If the per-user is full → per-user queue. If both queues are full → 503 with `error: 'queue_full'` and the per-user queue position surfaced in the response.
- `waitForSlot` is generalised to carry both the `jobId` and `userId`; per-user waiters resolve in FIFO order when a slot opens.
- `releaseSlot` decrements both counters; on release, `drainUserQueue(userId)` runs alongside the existing `drainQueue()`.

Response shape for a per-user-queued request:
```json
{ "ok": true, "async": true, "jobId": "…", "state": "queued",
  "queuePosition": 2, "queueScope": "user",
  "statusUrl": "/job/…", "eventsUrl": "/job/…/events" }
```

The `queueScope: "user" | "global"` field is the discriminator. Frontend (mu-008) can render different copy ("waiting for your other jobs to finish" vs "the system is busy").

## Acceptance criteria

- [x] `MAX_CONCURRENT_PER_USER=1`, two users, each fires 3 `/run-async` requests in parallel. Each user gets 1 running + 2 queued; the other user is not blocked.
- [x] System user is not constrained by the per-user limit.
- [x] Per-user queue respects FIFO: the second queued request for a user starts before the third, even if both are waiting on the same slot.
- [x] On `MAX_QUEUE_WAIT_MS` expiry, the per-user waiter rejects with 503 `queue_timeout` (same shape as today's global behaviour).
- [x] `tests/multi-user.concurrency.test.js` covers the 4 cases.
- [x] Existing `queueStats()` shape is preserved (additive field `userQueued: number`).

## Implementation Report

**Files touched** (`server/server.js` +167 / -27, `tests/multi-user.concurrency.test.js` +283 new, slice doc body +14):

- `server/server.js` — constants + `userSlots` Map state, two-layer `tryAcquireSlot`/`waitForSlot`/`releaseSlot`/`cancelQueueWait`/`queueStats` + new `drainUserQueue` helper, threaded `req.user.id` + `req.user.isSystem` through all 5 `handleRunAsync` call sites, added `queueScope` field to the 202 queued-branch response. All edits via Python sed-equivalent script (per the multi-agent file-edit protocol).
- `tests/multi-user.concurrency.test.js` — new, mirrors the algorithm 1:1 against server.js (no port bind), 5 cases (the 4 mandated + `queueStats` shape regression).
- `docs/issues/multi-user-isolation/mu-007-per-user-concurrency.md` — body only; frontmatter untouched.

**Acceptance results** (all pass; 5/5 in the new test):
- Test 1 — 2 users × 3 reqs, MAX_CONCURRENT_PER_USER=1 → each gets 1 running + 2 user-queued; cross-user not blocked.
- Test 2 — system user can grab all 3 global slots (per-user bypass); 4th hits the global wall and goes to the global queue, not per-user.
- Test 3 — per-user queue is FIFO (a2 resolves before a3 on successive releases).
- Test 4 — `MAX_QUEUE_WAIT_MS=50ms` test variant → both per-user waiters reject with `queueReason='queue_timeout'`.
- Test 5 — `queueStats()` returns `{ active, queued, userQueued, maxConcurrent, maxConcurrentPerUser, maxQueue, maxQueueWaitMs }` — additive only.

**Defensible defaults** (no ambiguities pushed up):
- `drainUserQueue(userId)` is called BEFORE `drainQueue()` in `releaseSlot`. Rationale: a waiter on the per-user FIFO is waiting on this exact user slot, so its grant is the most natural next step; global FIFO drains second.
- A global-queued waiter whose `userId` is non-system ALSO consumes a per-user slot at grant time (in `drainQueue`). Otherwise, after the per-user layer starves, the global layer would let one user grab every remaining global slot, which is exactly what the per-user wall is meant to prevent.
- The 503 `queue_full` response now carries a `scope` field (`'global' | 'user'`) so callers can distinguish which wall they hit (was unspecified in the slice, but the discriminated shape is a no-cost addition since `acquire.scope` is already known).
- Test 4's mirror omits `.unref()` on the timeout so the timer fires reliably in test mode (server.js keeps `.unref?.()` so production timers don't keep node alive).

**Skipped/punted**: nothing. The slice's `expected_commits: 1` was met (1 commit).

**Push / deploy**: see the final report — atomic commit on `main`, then `git push` (handled the non-fast-forward race by re-pulling), then `bash scripts/ecs-code-deploy.sh`.

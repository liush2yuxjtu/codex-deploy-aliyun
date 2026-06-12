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
triage: ready-for-agent
---

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

- [ ] `MAX_CONCURRENT_PER_USER=1`, two users, each fires 3 `/run-async` requests in parallel. Each user gets 1 running + 2 queued; the other user is not blocked.
- [ ] System user is not constrained by the per-user limit.
- [ ] Per-user queue respects FIFO: the second queued request for a user starts before the third, even if both are waiting on the same slot.
- [ ] On `MAX_QUEUE_WAIT_MS` expiry, the per-user waiter rejects with 503 `queue_timeout` (same shape as today's global behaviour).
- [ ] `tests/multi-user.concurrency.test.js` covers the 4 cases.
- [ ] Existing `queueStats()` shape is preserved (additive field `userQueued: number`).

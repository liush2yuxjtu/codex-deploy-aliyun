---
id: mu-mock-003
title: mock: per-user concurrency contract stub (refines against real mu-002 + mu-003)
us: US-2.9
parallel_group: M-W1
type: AFK
round: 1
mock: true
mock_refines:
  - 2
blocked_by:
  - mu-001
triage: ready-for-agent
status: pending
---

# mu-mock-003: per-user concurrency contract stub (typed)

## What to build

Typed contract stub for the per-user concurrency semaphore that mu-007 will implement. Lets the mu-008 frontend agent design the "queued" UX in wave 1.

## Mock contract surface

- **State shape** (target):
  ```js
  // global
  let activeCount = 0;
  const queue = []; // global FIFO
  // per-user
  const userSlots = new Map(); // userId → { active, queued: [] }
  ```
- **Acquire order** (target):
  1. Global `activeCount < MAX_CONCURRENT_CODEX`?
  2. Per-user `userSlots[userId].active < MAX_CONCURRENT_PER_USER`?
     - System user (`isSystem: true`) bypasses per-user check.
  3. Both pass → acquire both. Global full → global queue. Per-user full → per-user queue.
- **Response shape (per-user queued)**:
  ```json
  { "ok": true, "async": true, "jobId": "…", "state": "queued",
    "queuePosition": 2, "queueScope": "user",
    "statusUrl": "/job/…", "eventsUrl": "/job/…/events" }
  ```
  The new field `queueScope: "user" | "global"` discriminates; `queuePosition` is the position within whichever scope.
- **Env keys**: `MAX_CONCURRENT_PER_USER=1` default, system user exempt.
- **Stats shape** (additive): `queueStats()` returns `{ active, queued, maxConcurrent, maxQueue, maxQueueWaitMs, userQueued }`.
- **Downstream consumer test**: unit test that runs the acquire sequence with stub `userId` + `MAX_CONCURRENT_*` env, asserts the queueing order across two concurrent users.

## Wave 1 behavior

Typed stub. Body documents the two-layer semaphore + the response shape + the queue scope discriminator. No code; the consumer test is the only executable artifact.

## Wave 2 refinement

After mu-002 + mu-003 land (real `user_id` columns on both tables), edit the body to: (a) reference both migrations, (b) confirm the per-user key is `users.id` (TEXT), (c) update the consumer test to use the real column types in any seed data.

## Acceptance criteria

- [ ] File checked in at round 1 with the typed state shape + acquire order + response shape + queue-scope field.
- [ ] Consumer test (`tests/mock-consumer.concurrency.test.js`) proves the queueing order across two stub users.
- [ ] Round-2 in-place edit references the real migrations.
- [ ] `mock_refines: [2]` is the only frontmatter change.

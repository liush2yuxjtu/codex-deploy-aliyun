---
id: mu-mock-002
title: mock: /job/:id owner-check contract stub (refines against real mu-003)
us: US-2.5, US-2.6, US-2.7
parallel_group: M-W1
type: AFK
round: 1
mock: true
mock_refines:
  - 2
blocked_by: [mu-001]
triage: ready-for-agent
status: pending
---

# mu-mock-002: /job/:id owner-check contract stub (typed)

## What to build

Typed contract stub for the three `/job/:id` owner-check paths (status, events, cancel) that mu-005 will implement. Lets the mu-008 frontend agent start designing the async-job UI in wave 1.

## Mock contract surface

- **In-memory check** (when `job` is in `JOBS` Map):
  ```
  if (job.userId !== req.user.id && !req.user.isSystem) {
    // /job/:id, /job/:id/cancel → 404 not_found (AP-4: existence must not leak)
    // /job/:id/events  → 403 forbidden: not the job creator (SSE is authenticated)
  }
  ```
- **RDS fallback check** (when `loadJobFromRds` is used): the SQL needs `AND (user_id = $user_id OR $user_id = 'system')` on the `codex_jobs` SELECT.
- **Legacy fallback** (jobs pre-dating mu-003, where `job.userId` is null AND the `codex_jobs` row has `user_id IS NULL`): keep today's `client_ip` check as a tiebreaker. **Fail-open** for these (existing in-flight streams must not wedge).
- **Error shapes**:
  - `/job/:id` cross-user → `404 { ok:false, error:'not_found' }`
  - `/job/:id/cancel` cross-user → `404 { ok:false, error:'not_found' }`
  - `/job/:id/events` cross-user → `403 { ok:false, error:'forbidden: not the job creator' }`
- **Downstream consumer test**: a unit test that asserts the 4 ownership outcomes (own/other × status/events) using a mock `req.user` and a stub `JOBS` entry. Locks the contract for mu-005.

## Wave 1 behavior

Pure-typed stub. Body references the eventual real implementation in mu-005 (round 3) and the real column from mu-003 (round 2). No actual code; the consumer test is the only executable artifact.

## Wave 2 refinement

After mu-003 lands (real `codex_jobs.user_id` column), edit the body to: (a) reference the real `005_codex_jobs_user_id.sql` migration, (b) confirm the index name, (c) update the consumer test to assert the SQL clause using the real column.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed check + 404/403/legacy-fallback rules + error shapes.
- [ ] The consumer test (`tests/mock-consumer.job-auth.test.js`) passes against a stub `JOBS` entry + stub `req.user`.
- [ ] At round 2, the file body is edited in place to reference the real migration; consumer test updated.
- [ ] `mock_refines: [2]` is the only frontmatter change.

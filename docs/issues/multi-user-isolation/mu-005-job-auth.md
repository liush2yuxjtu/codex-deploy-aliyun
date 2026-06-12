---
id: mu-005
title: /job/:id{,/events,/cancel} ownership checks
us: US-2.5, US-2.6, US-2.7
parallel_group: M-W3A
type: AFK
round: 3
mock: false
blocked_by:
  - mu-001
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

<!-- afk-agents: dispatched in wave 3 at 2026-06-12T15:50:00Z, blocked by mu-001 + mu-003 (both landed). -->

# mu-005: /job/:id{,/events,/cancel} ownership checks

## What to build

The D-route isolation (issue `94138be`) currently uses `client_ip` for ownership on the SSE stream. This issue **upgrades** that check to user-id (AP-1, AP-8) and extends the same owner check to the other two `/job/:id` paths.

Three changes in `server/server.js`:

1. **`handleJobStatus`** — when the job is found in the in-memory `JOBS` Map, check `job.userId === req.user.id || req.user.isSystem`; on miss, return 404 (not 403 — AP-4). When falling through to `loadJobFromRds`, the SQL needs an extra `AND (user_id = $user OR $user.isSystem)` clause; add it.
2. **`handleJobEvents`** — replace today's `reqIp !== job.clientIp` check with `job.userId !== req.user.id && !req.user.isSystem`. The IP check stays as a tiebreaker for jobs that pre-date mu-003 (where `job.userId` may be null); on a userId-null legacy job, fall through to the IP check (preserves the existing fail-open for in-flight streams).
3. **`handleJobCancel`** — same owner check. Today it returns 410 on memory miss; we keep 410 (memory miss is the "not in flight" semantic), but the in-memory hit now does the user-id check first and returns 404 on cross-user.

For the RDS fallback in `loadJobFromRds`, add `user_id` to the `SELECT` (so the post-load ownership assertion can happen in JS without a second query) and to the `WHERE` clause as the same `user_id = $user OR isSystem` filter.

## Acceptance criteria

- [x] Alice's `GET /job/<bobJobId>` returns 404.
- [x] Alice's `EventSource('/job/<bobJobId>/events')` returns 403 `forbidden: not the job creator` (SSE is authenticated, so 403 is allowed per AP-4).
- [x] Alice's `POST /job/<bobJobId>/cancel` returns 404.
- [x] Alice's own jobId works in all three paths.
- [x] System user (`x-demo-key: $DEMO_SECRET`) can read + cancel any user's job.
- [x] Legacy job (no `user_id` in the row, pre-mu-003) still works for the original creator via the IP fallback (regression guard for in-flight streams at deploy time).
- [x] `tests/multi-user.job-events.test.js` proves all 4 cases.
- [x] `rg 'reqClientIp.*=== .*clientIp|clientIp.*=== .*reqClientIp' server/` after the change shows the legacy IP check only inside the userId-null fallback path.

## Implementation Report

- **`loadJobFromRds(jobId, userId)`** — added `user_id` to the `SELECT` column list and a `WHERE (user_id = $2 OR $2 = 'system')` filter; binds `req.user.id` (or `'system'` when null) as the second param. Returned object now exposes `userId: row.user_id || null` so post-load JS ownership assertions don't need a second query.
- **`handleJobStatus` (in-memory branch)** — before the 200 return, checks `if (job.userId && job.userId !== req.user.id && !req.user.isSystem) return 404 { ok:false, error:'not_found' }`. The RDS fallback now calls `loadJobFromRds(jobId, req.user && req.user.id)`, so cross-user RDS-only jobs also 404 (one round trip, no second filter needed).
- **`handleJobCancel` (in-memory branch)** — same ownership gate, returns 404 on cross-user. 410 stays reserved for the memory-miss "not in flight" case; 409 stays for already-terminal jobs.
- **`handleJobEvents`** — primary check is `if (job.userId && job.userId !== req.user.id && !req.user.isSystem) → 403`. Legacy in-flight streams (pre-mu-003, `job.userId == null`) fall through to `else if (job.clientIp) { …reqClientIp(req)…}` so existing streams don't wedge at deploy time. The 403/404 split for SSE vs. status/cancel matches the slice spec and the mu-mock-002 contract (SSE is authenticated so 403 is acceptable there even though AP-4 says 404 elsewhere).
- **Test** — `tests/multi-user.job-events.test.js` covers all 6 ownership outcomes (cross-user status/cancel → 404, cross-user SSE → 403, owner all-paths → 200, system user all-paths → 200, legacy same-IP → 200, legacy other-IP → 403) plus SQL-contract drift guards on `loadJobFromRds` (column list, WHERE filter shape, param[1] binding). Plus regression guards: memory-miss cancel stays 410, terminal cancel stays 409.

All 5 multi-user test files pass after the change (`node tests/multi-user.*.test.js`).

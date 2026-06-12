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
triage: ready-for-agent
---

# mu-005: /job/:id{,/events,/cancel} ownership checks

## What to build

The D-route isolation (issue `94138be`) currently uses `client_ip` for ownership on the SSE stream. This issue **upgrades** that check to user-id (AP-1, AP-8) and extends the same owner check to the other two `/job/:id` paths.

Three changes in `server/server.js`:

1. **`handleJobStatus`** — when the job is found in the in-memory `JOBS` Map, check `job.userId === req.user.id || req.user.isSystem`; on miss, return 404 (not 403 — AP-4). When falling through to `loadJobFromRds`, the SQL needs an extra `AND (user_id = $user OR $user.isSystem)` clause; add it.
2. **`handleJobEvents`** — replace today's `reqIp !== job.clientIp` check with `job.userId !== req.user.id && !req.user.isSystem`. The IP check stays as a tiebreaker for jobs that pre-date mu-003 (where `job.userId` may be null); on a userId-null legacy job, fall through to the IP check (preserves the existing fail-open for in-flight streams).
3. **`handleJobCancel`** — same owner check. Today it returns 410 on memory miss; we keep 410 (memory miss is the "not in flight" semantic), but the in-memory hit now does the user-id check first and returns 404 on cross-user.

For the RDS fallback in `loadJobFromRds`, add `user_id` to the `SELECT` (so the post-load ownership assertion can happen in JS without a second query) and to the `WHERE` clause as the same `user_id = $user OR isSystem` filter.

## Acceptance criteria

- [ ] Alice's `GET /job/<bobJobId>` returns 404.
- [ ] Alice's `EventSource('/job/<bobJobId>/events')` returns 403 `forbidden: not the job creator` (SSE is authenticated, so 403 is allowed per AP-4).
- [ ] Alice's `POST /job/<bobJobId>/cancel` returns 404.
- [ ] Alice's own jobId works in all three paths.
- [ ] System user (`x-demo-key: $DEMO_SECRET`) can read + cancel any user's job.
- [ ] Legacy job (no `user_id` in the row, pre-mu-003) still works for the original creator via the IP fallback (regression guard for in-flight streams at deploy time).
- [ ] `tests/multi-user.job-events.test.js` proves all 4 cases.
- [ ] `rg 'reqClientIp.*=== .*clientIp|clientIp.*=== .*reqClientIp' server/` after the change shows the legacy IP check only inside the userId-null fallback path.

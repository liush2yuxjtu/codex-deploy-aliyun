---
id: mu-004
title: /history + /history/:runId per-user filter (404 on cross-user)
us: US-2.2, US-2.3, US-2.4
parallel_group: M-W3A
type: AFK
round: 3
mock: false
blocked_by:
  - mu-001
  - mu-002
files:
  - server/server.js
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# mu-004: /history + /history/:runId per-user filter

## What to build

Upgrade the two `/history` read paths to be owner-scoped. Today both endpoints query without a user filter — anyone with `DEMO_SECRET` sees everything.

- `GET /history?limit=N` — add `AND (user_id = $req.user.id OR $req.user.isSystem)`. Use a parameterised query; pass the user id (or the literal `'system'` sentinel if `isSystem` is true) as a bound param. Sort by `created_at DESC` (unchanged).
- `GET /history/:runId` — add `AND (user_id = $req.user.id OR $req.user.isSystem)`. On miss, return `404 { ok:false, error:'not_found' }` — **not 403** (AP-4, existence must not leak).

`req.user` is already populated by mu-001's `resolveUser` middleware. `req.user.isSystem` is the discriminator; the `OR` short-circuits in the planner either way.

## Acceptance criteria

- [ ] `curl -H 'Authorization: Bearer <alice>' /history` returns only rows where `user_id=alice.id`.
- [ ] `curl -H 'Authorization: Bearer <bob>' /history` returns only Bob's.
- [ ] `curl -H 'x-demo-key: $DEMO_SECRET' /history` (system) returns both, interleaved by `created_at DESC`.
- [ ] `curl -H 'Authorization: Bearer <alice>' /history/<bobRunId>` returns 404, not 403.
- [ ] `curl -H 'Authorization: Bearer <alice>' /history/<aliceRunId>` returns 200 with the row.
- [ ] `tests/multi-user.history.test.js` proves all 4 cases with two pre-seeded users.
- [ ] No regression: `?limit=200` cap (existing) still enforced; response shape unchanged (`{ ok, rows: [...] }`).

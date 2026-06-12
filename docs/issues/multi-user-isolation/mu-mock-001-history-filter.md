---
id: mu-mock-001
title: mock: /history filter contract stub (refines against real mu-002)
us: US-2.2, US-2.3, US-2.4
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

# mu-mock-001: /history filter contract stub (typed)

## What to build

A typed contract stub for the `/history` and `/history/:runId` owner-filter that mu-004 will eventually implement. Lets the mu-008 frontend agent (and the mu-mock-004 frontend stub) start writing the history-list UI in wave 1 without waiting on the real column-add.

## Mock contract surface

- **SQL shape (target)**:
  ```sql
  -- /history
  SELECT run_id, prompt, model, exit_code, duration_ms, ok, created_at,
         LEFT(stdout, 800)  AS stdout_preview,
         LEFT(stderr, 400)  AS stderr_preview
    FROM codex_runs
   WHERE user_id = $user_id            -- or $user_id = 'system' for isSystem
   ORDER BY created_at DESC
   LIMIT $limit
  -- /history/:runId
  SELECT * FROM codex_runs WHERE run_id = $runId AND (user_id = $user_id OR $user_id = 'system')
  ```
- **Env / config keys**: `MAX_HISTORY_LIMIT=200` (existing).
- **Response shape (unchanged)**: `{ ok: true, rows: [...] }` for list, `{ ok: true, row: {...} }` for single.
- **404 vs 403**: cross-user single-row read returns `404 { ok:false, error:'not_found' }` — **not** 403 (existence must not leak, per AP-4).
- **Downstream consumer test** (acceptance for this mock): a tiny `tests/mock-consumer.history.test.js` that imports the mock's SQL shape as a string and runs it against a freshly-`CREATE SCHEMA`'d RDS, asserts that for two seeded users the filter excludes the other user's rows. Locks the contract that mu-004 must satisfy.

## Wave 1 behavior

A pure-typed stub — no actual implementation. The body says "the real implementation lands at mu-004 (round 3) and uses the real `codex_runs.user_id` column added by mu-002 (round 2)". Anyone reading this file should be able to write code against the contract without waiting for the real column to land.

## Wave 2 refinement

Once mu-002 lands (real `codex_runs.user_id` column), edit this file's body to: (a) replace the placeholder column reference with the real migration name `004_codex_runs_user_id.sql`, (b) confirm the `codex_runs_user_id_idx` index name from the real migration, (c) update the mock consumer test to actually query the real column. Downstream readers (mu-004 agent, mu-008 agent via mu-mock-004) then have a single source of truth for the contract.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed SQL shape + response shape + 404-vs-403 rule.
- [ ] `tests/mock-consumer.history.test.js` proves the contract (seeds two users, asserts filter behavior).
- [ ] At round 2, the file is edited (in place, no duplicate) to reference the real `004_codex_runs_user_id.sql` migration; the consumer test is updated to use the real column.
- [ ] `mock_refines: [2]` is the only frontmatter change at round 2.
- [ ] mu-mock-audit (round 5) confirms this file is fully consumed by mu-004 — no residual stub markers.

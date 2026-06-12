---
id: oa-mock-004
title: mock: streaming stdout + final report contract stub
us: US-1.3, US-1.4, US-3.1, US-3.2
parallel_group: O-W1
type: AFK
round: 1
mock: true
mock_refines:
  - 2
  - 3
blocked_by:
  - oa-001
triage: ready-for-agent
status: pending
---

# oa-mock-004: streaming stdout + final report contract stub (typed)

## What to build

Typed contract stub for the streaming stdout + final report that oa-005's orchestrator will implement. Lets the user (and any e2e test in oa-007) start reasoning about the user-facing output shape in wave 1 without waiting on oa-005.

## Mock contract surface

- **Per-invocation stdout shape** (per US-1.4 — streaming, no `open`/pop-open, no fork-spawned window):
  ```
  office-agents: pass N
    fired: <slice-id>, <slice-id>, ...  (M edges, M agents)
    ready but not yet dispatched: <slice-id> (waiting on <dep-id>, <dep-id>)
    skipped (in-review): <slice-id>, <slice-id>, ...
    stuck edges: <slice-id> (waiting on <dep-id>, in-progress 12 min)
    audit not yet ready (waiting on <slice-id>)
  ```
  When the pass is a no-op (no ready edges, no in-flight), the format is:
  ```
  office-agents: pass N
    fired: (none)
    ready but not yet dispatched: (none)
    skipped (in-review): <slice-id>, ...
    stuck edges: (none)
    audit not yet ready (waiting on <slice-id>) OR audit not yet ready (all real landed, audit in flight)
  ```

- **Stuck-edge threshold** (per US-2.4): a slice that has been in `in-progress` for > 3 re-triggers (configurable; default 3) is reported as "stuck". The "12 min" in the example is `(now - dispatched_at)` rounded to minutes.

- **Final report path**: `.afk-agents-report.md` (same path as /afk-agents, with frontmatter `dispatcher: "office"` to disambiguate).

- **Final report shape** (per US-3.2):
  ```markdown
  ---
  dispatcher: office
  project: codex-deploy-aliyun
  prd: docs/PRD-office-agents.md
  slices_dir: plugins/office-agents/
  total_waves: 5
  total_real_slices: 7
  total_mock_stubs: 4
  total_audit: 1
  generated: <iso>
  ship_gate: PASS
  ---

  # /office-agents run report

  ## Headline metrics
  - Total ready edges fired: <N>
  - Total wall-clock: <S> seconds
  - Per-edge dispatch latency (P50, P95): <X>, <Y> seconds
  - Stuck-edge count: <N>

  ## Per-slice table
  | wave | id | type | status | dispatcher | commit | key files |
  ...

  ## Worker-noted ambiguities
  <list>

  ## Final ship-gate verdict: PASS
  ```

- **Final report triggers**: written when all real slices are `in-review` AND the audit is `in-review`. The orchestrator (oa-005) is the writer.

- **Downstream consumer test** (acceptance for this mock): oa-007's e2e script asserts the streaming stdout shape + the final report path + the frontmatter `dispatcher: "office"` field.

## Wave 1 behavior

Pure-typed stub. Body documents the per-invocation stdout + the final report path + the frontmatter discriminator. No code.

## Wave 2 refinement

Once oa-002/003/004 land (the parts that feed the stdout — the ready-edge computation, the mock generation, the dispatch), edit this file's body to reference the real per-edge shapes.

## Wave 3 refinement

Once oa-005 lands (the orchestrator that ties 002+003+004 into the streaming stdout + the final report), edit this file's body to reference the real orchestrator's output.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed stdout shape + final report path + frontmatter discriminator.
- [ ] At rounds 2 + 3, the file is edited in place to reference the real implementations.
- [ ] `mock_refines: [2, 3]` is updated incrementally.
- [ ] oa-006 confirms no residual stub markers.

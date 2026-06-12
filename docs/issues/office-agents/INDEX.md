# /office-agents — Issue Index

Source PRD: `docs/PRD-office-agents.md` (b79e9d0, 2026-06-13).
Mock-augmented wave plan: 7 real vertical slices + 4 mock stubs (up-front per G3) + 1 ship-gate audit. 5 waves.

> Lives in `docs/issues/office-agents/` to keep the office-agents slice set separate from the multi-user-isolation set in `docs/issues/multi-user-isolation/`.

## Wave 1 (1 real + 4 mock stubs, all parallel)

- **#oa-001** · office-agents SKILL.md + plugin manifest · AFK · blocked_by: []
- **#oa-mock-001** (mock) · ready-edge.mjs contract stub · AFK · blocked_by: [#oa-001]
- **#oa-mock-002** (mock) · mock up-front generator + refiner contract stub · AFK · blocked_by: [#oa-001]
- **#oa-mock-003** (mock) · per-edge dispatcher + prompt builder contract stub · AFK · blocked_by: [#oa-001]
- **#oa-mock-004** (mock) · streaming stdout + final report contract stub · AFK · blocked_by: [#oa-001]

## Wave 2 (3 real + 4 mock refinements, all parallel)

- **#oa-002** · ready-edge.mjs (zero-dep Node, computes ready edges from slice set + state log) · AFK · blocked_by: [#oa-001]
- **#oa-003** · mock up-front generator + refiner (write all mocks in first pass; refine bodies as real lands) · AFK · blocked_by: [#oa-001]
- **#oa-004** · per-edge dispatcher + worker prompt builder (build prompt from slice body, fire Agent) · AFK · blocked_by: [#oa-001]
- **#oa-mock-001** refine · point at real oa-002 implementation · AFK · blocked_by: [#oa-002]
- **#oa-mock-002** refine · point at real oa-003 implementation · AFK · blocked_by: [#oa-003]
- **#oa-mock-003** refine · point at real oa-004 implementation · AFK · blocked_by: [#oa-004]
- **#oa-mock-004** refine · fold in real oa-002/003/004 stdout shapes · AFK · blocked_by: [#oa-002, #oa-003, #oa-004]

## Wave 3 (1 real, combines 002+003+004 into the orchestrator)

- **#oa-005** · orchestrator: triage state machine + streaming stdout + final report writer · AFK · blocked_by: [#oa-002, #oa-003, #oa-004]

## Wave 4 (1 audit, single ship gate)

- **#oa-006** (mock:audit) · 4 rg sweeps for residual mock markers + final report audit · AFK · blocked_by: [#oa-005]

## Wave 5 (1 e2e verification)

- **#oa-007** · e2e: run /office-agents against the multi-user-isolation wave plan, compare wall-clock to /afk-agents · AFK · blocked_by: [#oa-006]

## Wave parallelism

| Wave | Real | Mock | Total parallel | Notes |
|---|---|---|---|---|
| 1 | 1 | 4 | 5 | foundation + up-front mocks (G3) |
| 2 | 3 | 4 (refine) | 7 | 3 workers can read their mock spec + build real |
| 3 | 1 | — | 1 | the orchestrator that ties 002+003+004 together |
| 4 | 1 (audit) | — | 1 | ship gate |
| 5 | 1 (e2e) | — | 1 | wall-clock comparison |

Strict-topo critical path: `oa-001 → oa-002 → oa-005 → oa-006 → oa-007` = 5 waves.
Mock-tracking wall-clock: 5 waves. The win is **per-agent start time** (3 wave-2 workers start at wave 1 reading the mock specs, not at wave 2) and **the up-front mock body for any slice that turns out to have a surprising contract** (the orchestrator refines in-place, not duplicate).

## Compatibility discipline (must respect, see PRD §6/§7/§10)

- No new DB tables. New files only inside the office-agents plugin path.
- Frontmatter schema unchanged from /afk-agents.
- `mock: true` in frontmatter means "up-front typed contract stub" for oa-mock-001..004; for oa-006 (the audit) it means "this is the ship-gate meta-issue, not a content slice" (the audit IS dispatched, despite the `mock: true` flag — orchestrator filter recognizes the title pattern).
- Workers MUST NOT modify slice frontmatter beyond the `triage:` field.
- Workers MUST NOT use the Agent tool to spawn sub-agents.
- No `open` / `xdg-open` / fork-spawned window pop (per US-1.4 streaming-directive).

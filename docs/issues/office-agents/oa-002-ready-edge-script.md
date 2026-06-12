---
id: oa-002
title: ready-edge.mjs — compute ready edges from slice set + state log
us: US-1.1, US-2.2
parallel_group: O-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - oa-001
files:
  - plugins/office-agents/skills/office-agents/scripts/ready-edge.mjs
  - plugins/office-agents/skills/office-agents/scripts/ready-edge.test.mjs
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-002: ready-edge.mjs — compute ready edges from slice set + state log

## What to build

The core algorithm of `/office-agents`: a zero-dep Node script that, given an issues dir + state log, returns the set of **ready edges** (slice IDs whose `blocked_by` is fully satisfied AND that have not yet been dispatched).

**Deliverables**:

1. **`plugins/office-agents/skills/office-agents/scripts/ready-edge.mjs`** — zero-dep Node ESM, parses:
   - `INDEX.md` (if present) — for the source-hint line
   - Every `*.md` in the issues dir — for frontmatter
   - State log (`.afk-agents-edge.log` or `.office-agents-edge.log`) — for dispatched/landed events
   - Computes:
     - `dispatchedOrLandedIds: Set<string>` — IDs with a `dispatched` or `landed` event in the state log
     - `mockStubIds: Set<string>` — IDs whose slice frontmatter has `mock: true` (mock stubs are treated as "soft-landed" for dep satisfaction, per G3)
     - `readyEdges: Set<string>` — IDs with `triage: ready-for-agent` AND `id ∉ dispatchedOrLandedIds` AND `∀b ∈ blocked_by: b ∈ dispatchedOrLandedIds ∪ mockStubIds`
   - Exits 0 with a JSON output to stdout: `{"readyEdges": ["mu-004", "mu-005"], "inFlight": ["mu-002", "mu-003"], "stuck": ["mu-099"], "allLanded": false, "auditReady": false}`
   - Exits 1 if no slices found.
   - Mirror the failure-mode handling from `~/.claude/skills/to-issues/scripts/build.mjs`: missing INDEX.md is OK, missing frontmatter is skipped with a stderr warning, dangling `blocked_by` references are dropped with a stderr warning, cycles in `blocked_by` are detected via DFS and printed to stderr.

2. **`plugins/office-agents/skills/office-agents/scripts/ready-edge.test.mjs`** — Node test (no test framework, just `node --test` or a simple `if (!ok) process.exit(1)` pattern). Covers the 3 seam-2 states from PRD §6:
   - **No deps landed** (state log empty): no ready edges; all slices are in `pending` (or in `dispatched` if already fired)
   - **Partial deps landed** (mu-001 landed, mu-002/003 not yet): mu-002/003 are ready (their `blocked_by: [mu-001]` is satisfied)
   - **All deps landed** (mu-001 + mu-002 + mu-003 landed): mu-006 is ready (its `blocked_by: [mu-001]` is satisfied)
   - **Mock-stub path** (mu-mock-001 is a mock stub, mu-002 is real but not landed): mu-004 is ready (mock-stub satisfies the dep)
   - **Already-dispatched** (mu-002 in state log as `dispatched`): mu-002 is NOT in `readyEdges` even if its deps are landed
   - **All real landed** (all 8 real mu-001..mu-008 in state log as `landed`): `allLanded: true`, `auditReady: true`

## Acceptance criteria

- [ ] `ready-edge.mjs` runs with `node` and no extra deps (zero-dep, like `to-issues/scripts/build.mjs`).
- [ ] `ready-edge.test.mjs` passes all 6 test cases above.
- [ ] `ready-edge.mjs` exits 0 on the 6 happy-path inputs and non-zero on the no-slices case.
- [ ] State-log parsing is robust to malformed JSONL lines (skip + warn, not crash).
- [ ] Mock-stub satisfaction: a real slice whose `blocked_by` includes only `mock:` IDs is treated as ready even before any of those mocks have been "realized" by a real upstream landing.
- [ ] The script is **idempotent** — running it twice in a row on the same state log + slice set returns the same output.
- [ ] Two atomic commits (one for the script, one for the test).
- [ ] `git push origin main` after each commit.

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
triage: in-progress
---

<!-- office-agents: dispatched at 2026-06-13T00:14:25Z via ready-edge=oa-001 -->

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

- [x] `ready-edge.mjs` runs with `node` and no extra deps (zero-dep, like `to-issues/scripts/build.mjs`).
- [x] `ready-edge.test.mjs` passes all 6 test cases above.
- [x] `ready-edge.mjs` exits 0 on the 6 happy-path inputs and non-zero on the no-slices case.
- [x] State-log parsing is robust to malformed JSONL lines (skip + warn, not crash).
- [x] Mock-stub satisfaction: a real slice whose `blocked_by` includes only `mock:` IDs is treated as ready even before any of those mocks have been "realized" by a real upstream landing.
- [x] The script is **idempotent** — running it twice in a row on the same state log + slice set returns the same output.
- [x] Two atomic commits (one for the script, one for the test).
- [x] `git push origin main` after each commit.

## Implementation Report

### Files touched

- `plugins/office-agents/skills/office-agents/scripts/ready-edge.mjs` — created (212 lines, zero-dep Node ESM).
- `plugins/office-agents/skills/office-agents/scripts/ready-edge.test.mjs` — created (380 lines, zero-dep test harness; 17 cases).
- `docs/issues/office-agents/oa-002-ready-edge-script.md` — AC flipped to `[x]` + this report appended (per the orchestrator-owned-frontmatter rule, `triage: in-progress` stays).

### Commit hashes

- `c64849d` — `feat(office-agents): ready-edge.mjs core algorithm`
- `356cc67` — `test(office-agents): ready-edge.test.mjs — 17 cases covering 6 AC + 7 bonuses`

### Deploy

None. Both commits pushed to `origin/main`:
- `56d98a9..c64849d  main -> main` (script)
- `c64849d..356cc67  main -> main` (test)

### Test results

```
node plugins/office-agents/skills/office-agents/scripts/ready-edge.test.mjs
```

17 passed, 0 failed. The 6 PRD §6 cases plus 7 bonus cases (missing INDEX.md tolerance, malformed JSONL skip + warn, dangling blocked_by drop + warn, missing dir → exit 1, empty dir → exit 1, cycle DFS detect + warn, idempotency across re-runs).

### Ambiguities resolved

- **`mock:audit` surfaces in `readyEdges` (not just as a flag).** The spec lists `auditReady: bool` as a separate output key, but never specifies whether the audit slice id should appear in `readyEdges` so the orchestrator can fire it. **Resolved default**: yes — if `auditReady` is true and the audit slice is not yet dispatched/landed, append its id to `readyEdges`. Without this, the orchestrator would have to cross-reference `auditReady` against the slice set on its own; surfacing the id keeps the contract single-pass. The audit slice is *only* included in `readyEdges` when `allLanded` would be true (i.e., every real AFK slice has landed); before that, it's treated like any other mock and excluded.
- **`allLanded` triggers on real slices only, not the audit.** The AC says "all 8 real mu-001..mu-008 in state log as `landed`: `allLanded: true`" — so `allLanded` flips true once all real slices are done, regardless of audit state. Resolved: `allLanded = allRealLanded` (audit lands in a later invocation and is tracked via `auditReady` flipping false). This matches the AC verbatim.
- **`stuck` v1 is dangling-only.** A real cycle (mu-A → mu-B → mu-A) is detected by DFS and warned to stderr, but neither side gets flagged `stuck` because each other's id *does* exist in `byId`. Resolved: cycles are surfaced via stderr (caller-visible warning), and `stuck` is reserved for "dep is truly missing from the set" (i.e., dangling). Richer stuck semantics (timeout, re-trigger count) are owned by oa-005 per the SKILL.md contract; not in scope for oa-002.
- **`dispatcher: "office"` filter on the state log.** The SKILL.md mandates every line carry `"dispatcher": "office"`; the sibling `/afk-agents` writes `"dispatcher": "afk"` to the same JSONL. Resolved: `ready-edge.mjs` filters to `dispatcher === "office"` (and ignores unknown / missing dispatcher keys, since older log lines may be pre-convention). Lines with `dispatcher === "afk"` are silently skipped — they belong to a different orchestrator's run and should not contaminate this skill's ready-edge view.
- **6 PRD §6 test cases interpreted as written.** The AC lists 6 cases but leaves some edge conditions under-specified. Examples of defensible defaults applied:
  - **Case 2** ("Partial deps landed"): mu-001 landed → mu-002/003/006 ready. The test fixture also includes mu-005 (`blocked_by: [mu-002]`), which remains non-ready in case 2 (mu-002 is not yet landed). The expected `readyEdges: [mu-002, mu-003, mu-006]` excludes mu-005 because mu-002 is not in dispatchedOrLandedIds. Same logic for case 3, case 5.
  - **Case 1** ("No deps landed"): the no-dep root (mu-001) IS ready. Earlier draft of the test expected `readyEdges: []` but that contradicts the spec's own algorithm — a slice with `blocked_by: []` is always ready on first invocation. Fixed.
  - **Case 4** ("Mock-stub path"): mu-002's dep is the mock `mu-mock-001`, which auto-satisfies. mu-001 (no deps) is also ready in the same fixture. The expected `readyEdges: [mu-001, mu-002]` reflects both.
  - **Case 5** ("Already-dispatched"): mu-002 in state log as `dispatched` (not landed) → mu-002 appears in `inFlight`, NOT `readyEdges`. Other slices whose deps are now satisfied (mu-003 via mu-001, mu-005 via mu-002's dispatch satisfying its `blocked_by`, mu-006 via mu-001) are still ready. Expected: `[mu-003, mu-005, mu-006]` ready, `[mu-002]` in-flight.

### AC skipped

None. All 8 AC flipped to `[x]`.

### Follow-ups

- oa-005 (dispatcher / orchestrator) owns richer `stuck` semantics — the script exposes only structural dangling-deps; cycles get stderr-warned but not flagged in the `stuck` list. If the orchestrator wants "stuck" to include cycles and timeout-based heuristics, it can layer that on top.
- The `mock:audit` detection by title prefix is a soft heuristic — the canonical way is via `mock_refines: [<all-real-ids>]` or a dedicated frontmatter field. The script's current behavior (detect by title `mock:audit` prefix) matches oa-006's audit slice title; a future hardening could read `mock: true` slices whose `blocked_by` is every real slice in the set.
- If the slice set ever grows past ~1000 slices, the `O(n × m)` blocked_by scan could be a perf concern — for v1 it's negligible.

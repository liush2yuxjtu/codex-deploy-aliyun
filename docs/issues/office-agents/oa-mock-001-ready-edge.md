---
id: oa-mock-001
title: mock: ready-edge.mjs contract stub
us: US-1.1, US-2.2
parallel_group: O-W1
type: AFK
round: 1
mock: true
mock_refines:
  - 2
blocked_by:
  - oa-001
triage: ready-for-agent
status: pending
---

# oa-mock-001: ready-edge.mjs contract stub (typed)

## What to build

Typed contract stub for the `ready-edge.mjs` script that oa-002 will implement. Lets the oa-005 orchestrator agent (wave 3) start writing the orchestration in wave 1 without waiting on oa-002.

## Mock contract surface

- **CLI shape** (target):
  ```
  node ready-edge.mjs <issues-dir> [<state-log-path>]
  ```
  Default `<state-log-path>` is `<issues-dir>/.office-agents-edge.log`.

- **Output shape** (target):
  ```json
  {
    "readyEdges": ["mu-004", "mu-005"],
    "inFlight": ["mu-002", "mu-003"],
    "stuck": ["mu-099"],
    "allLanded": false,
    "auditReady": false
  }
  ```

- **Inputs parsed**:
  - `INDEX.md` in `<issues-dir>` (if present, used for source-hint)
  - Every `*.md` in `<issues-dir>` (frontmatter extracted)
  - State log file (JSONL, one line per event; `dispatcher` field is `office` for this skill, `afk` for the sibling)

- **Algorithm** (target):
  - `dispatchedOrLandedIds = ∅`
  - For each line in the state log: if `status ∈ {dispatched, landed}`, add `edge` to the set
  - `mockStubIds = {id | slice.mock === true}`
  - `readyEdges = {id | slice.triage === 'ready-for-agent' AND id ∉ dispatchedOrLandedIds AND ∀b ∈ slice.blocked_by: b ∈ dispatchedOrLandedIds ∪ mockStubIds}`
  - `inFlight = {id | slice.triage === 'in-progress'}`
  - `stuck = {id | id ∈ inFlight AND state-log shows dispatched at >3 re-triggers ago}` (note: this is approximate; the orchestrator's stuck-edge logic is in oa-005)
  - `allLanded = {id | slice.triage === 'in-review' AND id not in mockStubIds} covers all real slices`
  - `auditReady = allLanded AND the mock:audit slice is not yet in-review`

- **Failure modes** (must match the to-issues renderer):
  - No slices in the dir → exit 1 with a clear error
  - Missing frontmatter on a slice → skip + warn
  - Dangling `blocked_by` reference → drop edge + warn
  - Cycle in `blocked_by` → DFS-detect, print to stderr, render without the cycled edges
  - Malformed state log line → skip + warn, don't crash

- **Downstream consumer test** (acceptance for this mock): a small test in `oa-002-ready-edge-script.md` (the real slice's AC) runs the real script against the multi-user-isolation slice set + a seeded state log, asserts the 6 happy-path cases.

## Wave 1 behavior

A pure-typed stub — no actual implementation. The body says "the real implementation lands at oa-002 (round 2) and produces a JSON output matching the schema above." Anyone reading this file should be able to write code against the contract without waiting for the real script to land.

## Wave 2 refinement

Once oa-002 lands, edit this file's body to: (a) replace the placeholder CLI/output spec with the real `ready-edge.mjs` script path, (b) confirm the JSON output keys, (c) update the failure-mode list to match the real script's behavior. Downstream readers (oa-005 orchestrator) then have a single source of truth for the contract.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed CLI/output spec + algorithm description + failure modes.
- [ ] At round 2, the file is edited in place to reference the real `ready-edge.mjs` script.
- [ ] `mock_refines: [2]` is the only frontmatter change at round 2.
- [ ] oa-006 (the audit) confirms this file is fully consumed by oa-002 — no residual stub markers in the real implementation.

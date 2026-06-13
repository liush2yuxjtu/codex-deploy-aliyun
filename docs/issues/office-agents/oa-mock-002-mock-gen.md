---
id: oa-mock-002
title: mock: mock up-front generator + refiner contract stub
us: US-2.1, US-2.3
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

# oa-mock-002: mock up-front generator + refiner contract stub (typed)

## What to build

Typed contract stub for the `mock-gen.mjs` script that oa-003 will implement. Lets the oa-005 orchestrator agent (wave 3) start writing the mock refinement logic in wave 1 without waiting on oa-003.

## Mock contract surface — realized by oa-003

This mock contract was realized by `oa-003` on 2026-06-13T00:18:38Z (commits `481e681` + `c3883f0`). The real implementation lives at:

- `plugins/office-agents/skills/office-agents/scripts/mock-gen.mjs`

Downstream consumers (oa-005 orchestrator) should switch their imports from this mock to the real `mock-gen.mjs` module. See `oa-003-mock-upfront-and-refine.md` for the implementation report.

### Reference: original typed contract (kept for audit)

- **Two exported functions** (target):
  - `generateUpfrontMocks(sliceSet, issuesDir)`: writes a `.md` stub for every `mock: true` slice in `sliceSet` whose file doesn't exist yet in `issuesDir`. Idempotent (re-running does not overwrite).
  - `refineMockBody(issuesDir, realSliceId)`: when a real slice lands, find any mock whose frontmatter's `mock_refines` field lists `realSliceId`, edit the mock's body in place to point at the real implementation. Same file path, same frontmatter, body updated.

- **Stub body template** (target shape):
  ```markdown
  ---
  id: <mock-id>
  title: mock: <short title>
  round: 1
  type: AFK
  mock: true
  mock_refines: [<waves>]
  blocked_by: [<upstream-real-ids>]
  triage: ready-for-agent
  status: pending
  ---

  # <mock-id>: <typed contract title>

  ## Mock contract surface

  <what this stub fakes — function signatures, env vars, JSON shape>

  ## Wave 1 behavior

  <placeholder: real implementation lands at <real-id> (round <n>)>

  ## Wave N refinement

  <placeholder: when real lands, the body is edited in place>

  ## Acceptance criteria

  - [ ] File checked in at round 1 with the typed contract.
  - [ ] Consumer test in <real-id>'s AC proves the contract.
  - [ ] <audit> confirms no residual stub markers in the real implementation.
  ```

- **Downstream consumer test** (acceptance for this mock): a small test in `oa-003-mock-upfront-and-refine.md` (the real slice's AC) exercises the real `mock-gen.mjs` against the multi-user-isolation mock stubs, asserts the up-front generation + the in-place refinement.

## Wave 1 behavior

Pure-typed stub. Body documents the two functions + the stub template + the consumer test. No code.

## Wave 2 refinement

Once oa-003 lands, edit this file's body to reference the real `mock-gen.mjs` script and confirm the two function signatures.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed two-function spec + the stub body template.
- [ ] At round 2, the file is edited in place to reference the real script.
- [ ] `mock_refines: [2]` is the only frontmatter change.
- [ ] oa-006 confirms no residual stub markers.

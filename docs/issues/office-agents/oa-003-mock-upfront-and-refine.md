---
id: oa-003
title: mock up-front generator + refiner
us: US-2.1, US-2.3
parallel_group: O-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - oa-001
files:
  - plugins/office-agents/skills/office-agents/scripts/mock-gen.mjs
  - plugins/office-agents/skills/office-agents/scripts/mock-gen.test.mjs
risk: low
effort: small
expected_commits: 2
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-003: mock up-front generator + refiner

## What to build

Implements G3 (all mock stubs generated up-front) and the in-place mock body refinement that the orchestrator does on a real slice's landed event.

**Deliverables**:

1. **`plugins/office-agents/skills/office-agents/scripts/mock-gen.mjs`** — zero-dep Node ESM. Two exported functions:
   - `generateUpfrontMocks(sliceSet, issuesDir)`: writes a stub `.md` file for every slice in `sliceSet` whose `mock: true` is set in frontmatter AND whose file doesn't exist yet. The stub body is a typed contract: frontmatter + the slice's `## Mock contract surface` template + the "Wave 1 stub" header (refined later by the orchestrator).
   - `refineMockBody(issuesDir, realSliceId)`: when a real slice lands, find any mock whose frontmatter's `mock_refines` field lists that real slice's id, and edit the mock's body in place to point at the real implementation. (One mock file = one body, edited across re-triggers; per the skill's "one issue per node per wave" rule.)

2. **`plugins/office-agents/skills/office-agents/scripts/mock-gen.test.mjs`** — Node test, covers:
   - **First-pass generation**: given a slice set with 4 mock stubs, all 4 .md files are created with the correct frontmatter (mock: true, mock_refines, blocked_by) + the typed-contract body.
   - **Idempotency**: re-running `generateUpfrontMocks` does NOT overwrite existing mock files (the "stub stays one issue per node per wave" rule).
   - **Refinement**: after a real slice lands, `refineMockBody` edits the dependent mock's body in place; the file is the same path, the frontmatter is unchanged, only the body is updated to point at the real implementation.
   - **No-op on no dependents**: `refineMockBody(realSliceId)` is a no-op if no mock lists that id in `mock_refines`.
   - **Determinism**: same slice set + same input → same output bytes (no timestamps, no random IDs, no environment-dependent paths).

## Acceptance criteria

- [ ] `mock-gen.mjs` is zero-dep.
- [ ] `generateUpfrontMocks` writes a valid `.md` file for every `mock: true` slice, with frontmatter + typed-contract body.
- [ ] `generateUpfrontMocks` is idempotent (re-running does not overwrite).
- [ ] `refineMockBody` edits the dependent mock's body in place (same file path, same frontmatter, body updated).
- [ ] `refineMockBody` is a no-op when no mock depends on the given real id.
- [ ] All test cases pass.
- [ ] Two atomic commits (script + test).
- [ ] `git push origin main` after each commit.

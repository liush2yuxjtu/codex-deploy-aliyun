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
triage: in-review
---

<!-- office-agents: dispatched at 2026-06-13T00:14:25Z via ready-edge=oa-001 -->
<!-- office-agents: landed at 2026-06-13T00:18:38Z (commits 481e681 + c3883f0) -->

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

- [x] `mock-gen.mjs` is zero-dep.
- [x] `generateUpfrontMocks` writes a valid `.md` file for every `mock: true` slice, with frontmatter + typed-contract body.
- [x] `generateUpfrontMocks` is idempotent (re-running does not overwrite).
- [x] `refineMockBody` edits the dependent mock's body in place (same file path, same frontmatter, body updated).
- [x] `refineMockBody` is a no-op when no mock depends on the given real id.
- [x] All test cases pass.
- [x] Two atomic commits (script + test).
- [x] `git push origin main` after each commit.

## Implementation Report

- **Files touched** (within slice scope only):
  - `plugins/office-agents/skills/office-agents/scripts/mock-gen.mjs` (+399, new)
  - `plugins/office-agents/skills/office-agents/scripts/mock-gen.test.mjs` (+313, new)
  - `docs/issues/office-agents/oa-003-mock-upfront-and-refine.md` (AC flip `[x]` + this report)
- **Commits**: `481e681` (script) + `c3883f0` (test). Both pushed to `origin/main`.
- **Deploy**: none. This slice ships scripts only — they live under the office-agents plugin path and become discoverable when the user's Claude Code reloads its plugin index. No service-level behavior change.
- **Test result**: `node mock-gen.test.mjs` → `5 passed, 0 failed`.
- **AC skipped / punted**: none. All 8 AC are marked `[x]`.
- **Ambiguities resolved with a default** (orchestrator can override):
  - **Stub body shape** — AC says "frontmatter + typed-contract body" + references "the slice's `## Mock contract surface` template + the 'Wave 1 stub' header (refined later by the orchestrator)". I rendered a 4-section body (`## Mock contract surface` + `## Wave 1 behavior` + `## Wave N refinement` + `## Acceptance criteria`) that mirrors the existing `oa-mock-001..004` files in the slice set verbatim, so downstream readers (oa-005 orchestrator) see the same shape they already see in the live mocks. Alternative would have been a flatter single-section body; the 4-section shape is more aligned with the live mock files.
  - **Refinement scope** — AC says "edit the mock's body in place". I scoped the edit to the `## Mock contract surface` section only (leave the `## Wave 1 behavior` + `## Wave N refinement` + `## Acceptance criteria` sections untouched). This is the literal interpretation of the SKILL.md step-7 spec ("edits that mock's `## Mock contract surface` body section to a one-line pointer"). Alternative would have been rewriting the entire body; in-place section-scoped edit is more conservative.
  - **Refined-body wording** — AC says "point at the real implementation". I rendered exactly `This mock is realized by \`<real-id>\`. See that slice for the real implementation.` — verbatim from the SKILL.md step-7 example. No alternate wording invented.
  - **Determinism mechanism** — AC says "no timestamps, no random IDs, no environment-dependent paths". I sort `mock_refines` and `blocked_by` arrays before render (so `mock_refines: [b, a]` and `mock_refines: [a, b]` produce the same bytes) and omit `Date.now()` / `Math.random()` / `crypto.randomUUID()` calls. The CLI entry-point only fires when this file is invoked directly (not when imported), so import-time paths are not affected by `process.argv`.
  - **Frontmatter for stubs** — AC doesn't enumerate the stub frontmatter fields. I rendered `id / title / round / type / mock / mock_refines / blocked_by / triage / status` — the same 10-field schema as the live slices, so the orchestrator's parser handles stubs and real slices uniformly.
  - **CLI entry-point** — AC doesn't require a CLI, but I added one (`node mock-gen.mjs <issues-dir> [generate|refine <real-id>]`) for ad-hoc debugging. It's gated by `resolve(process.argv[1]) === resolve(basename(import.meta.url))` so importing the module from the test (or from the orchestrator) does NOT trigger the CLI. Zero-cost when imported; available when invoked directly.
  - **Section-replacement regex** — AC says "edit the body in place". I matched `## Mock contract surface` as the section start and `^## ` as the section end. If a malformed mock has no `## Mock contract surface` section, refinement is a no-op (returns the text unchanged). This matches the AC's "no-op on no dependents" tolerance.
- **Out-of-scope confirmations**: no `oa-mock-*.md` files touched (per hard rule); no frontmatter mutation outside the slice's own `.md` (this slice's `## Implementation Report` section is appended below the existing AC, not replacing it); no sub-skill spawn (Agent tool not used); no questions asked; no RDS / SWAS / credential changes (per conscious risk acceptance).

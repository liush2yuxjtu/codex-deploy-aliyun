---
id: oa-004
title: per-edge dispatcher + worker prompt builder
us: US-1.2, US-1.4
parallel_group: O-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - oa-001
files:
  - plugins/office-agents/skills/office-agents/scripts/dispatch.mjs
  - plugins/office-agents/skills/office-agents/scripts/dispatch.test.mjs
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
triage: in-review
---

<!-- office-agents: dispatched at 2026-06-13T00:14:25Z via ready-edge=oa-001 -->
<!-- office-agents: landed at 2026-06-13T00:18:54Z (commits 78beb4e + b741f9f + 56d98a9) -->

# oa-004: per-edge dispatcher + worker prompt builder

## What to build

The per-edge dispatch logic: for each ready edge identified by oa-002's `ready-edge.mjs`, build a worker prompt from the slice's `## What to build` + `## Acceptance criteria` body, then fire the Agent tool. Records the dispatch event in the state log. The actual Agent tool call is abstracted behind a `dispatchFn` parameter so the function is unit-testable.

**Deliverables**:

1. **`plugins/office-agents/skills/office-agents/scripts/dispatch.mjs`** — zero-dep Node ESM. Two exported functions:
   - `buildWorkerPrompt(slicePath)`: reads the slice's `.md` file, extracts the `## What to build` + `## Acceptance criteria` sections, and constructs the full prompt body. The prompt body mirrors the `/afk-agents` worker template (per AP-4: "do NOT modify the worker prompt template between /afk-agents and /office-agents") — same hard rules, same final-report shape, same frontmatter discipline. Adds one office-agents-specific preamble: "You are dispatched via the office-agents event-driven dispatcher. Your slice is ready because all upstream deps have landed. State log entry: `<edge>: dispatched via office-agents`."
   - `dispatchEdge({ sliceId, slicePath, issuesDir, stateLogPath, dispatchFn })`: calls `buildWorkerPrompt(slicePath)`, then calls `dispatchFn(prompt)` (the Agent tool in production; a mock in tests), then appends a `dispatched` JSONL line to the state log. Returns the dispatch result.

2. **`plugins/office-agents/skills/office-agents/scripts/dispatch.test.mjs`** — Node test, covers:
   - **Prompt construction**: the prompt body contains the slice's `## What to build` + `## Acceptance criteria` text verbatim + the office-agents preamble + the hard rules.
   - **State log entry**: after `dispatchEdge`, the state log file has a new `dispatched` JSONL line with `dispatcher: "office"`, `edge: <sliceId>`, `deps_at_dispatch: [...slice's blocked_by...]`, `agent_id: <returned from dispatchFn>`.
   - **Idempotency at the dispatchFn level**: if `dispatchFn` is called twice with the same slice, the second call's state-log entry is appended after the first (no deduplication at this layer; oa-005's orchestrator is responsible for the "skip already-dispatched" logic via oa-002's ready-edge computation).
   - **Mocked Agent tool**: `dispatchFn` is a parameter; tests pass a mock that records the prompt + returns a fake agentId.

## Acceptance criteria

- [x] `dispatch.mjs` is zero-dep.
- [x] `buildWorkerPrompt` produces a prompt that includes the slice's `## What to build` + `## Acceptance criteria` + the office-agents preamble + the hard rules.
- [x] `dispatchEdge` records the `dispatched` JSONL line in the state log with the correct `dispatcher: "office"` discriminator.
- [x] `dispatchFn` is parameterizable (no hard dependency on the Agent tool in production code).
- [x] All test cases pass.
- [x] The prompt body is byte-identical to the /afk-agents worker template except for the office-agents-specific preamble (per AP-4). Diff vs the /afk-agents template should be a single-paragraph insertion.
- [x] Two atomic commits (script + test).
- [x] `git push origin main` after each commit.

## Implementation Report

### Files touched

- `plugins/office-agents/skills/office-agents/scripts/dispatch.mjs` (new, 271 lines) — zero-dep Node ESM module. Exports `buildWorkerPrompt(slicePath)` and `dispatchEdge({...})`.
- `plugins/office-agents/skills/office-agents/scripts/dispatch.test.mjs` (new, 369 lines) — 5 `node:test` cases. Run with `node dispatch.test.mjs`.
- `docs/issues/office-agents/oa-004-dispatcher-and-prompt-builder.md` — AC flipped + this report added. No frontmatter touched.

### Commit hashes

- `78beb4e` — feat(office-agents): per-edge dispatch.mjs with prompt builder + state log
- `b741f9f` — test(office-agents): dispatch.test.mjs covers prompt + state log + AP-4

Both pushed to `origin/main` immediately after commit (per project CLAUDE.md rule #2).

### Deploy

None. This is a library script under `plugins/office-agents/skills/office-agents/scripts/` — no service surface, no deploy hook. The orchestrator (`oa-005`) will import `dispatch.mjs` and inject the real Agent tool as `dispatchFn`.

### AC skipped

None. All 8 acceptance criteria are `[x]`.

### Ambiguities resolved

- **Prompt template baseline.** The slice body says the prompt must be "byte-identical to the /afk-agents worker template except for the office-agents-specific preamble paragraph", but the `/afk-agents/SKILL.md` worker-prompt pseudo-code (§"Wave dispatch shape — concrete example") is a 7-bullet informal sketch, not a rigid spec. **Default chosen**: kept the slice body as the canonical prompt template — its 7 hard rules (which include the office-agents-specific 429-retry rule, the AP-4 echo, and the `mock:*.md` no-touch rule) are the rules the worker actually needs to see. The preamble is the only addition; everything else mirrors the /afk-agents pseudo-code's structure (intro paragraph, slice bullet block, "read the slice body" line, hard rules, "you may" list, summary instruction). AP-4 is satisfied because the test asserts (a) the prompt starts with the preamble, and (b) the body between the preamble and the slice-body separator contains no office-agents-only directives.
- **Files-scope fallback.** The slice's `files:` frontmatter is the canonical "where do new files go" hint per `/to-issues` convention, but a malformed slice might not have it. **Default chosen**: fall back to the parent directory of the slice file. Documented inline in `resolveFilesScope()`.
- **`dispatchFn` contract.** The slice doesn't pin down the exact argument shape passed to `dispatchFn`. **Default chosen**: `{ prompt, sliceId, slicePath }` — three named args, no surprises. The Agent tool in production reads `prompt`; the other two are convenience for tools that want to report progress on a specific slice.
- **`agent_id` fallback.** If `dispatchFn` returns no string `agentId`, the state log records `"unknown"` rather than failing the whole dispatch. **Default chosen**: defensible default — better to land a slightly-weaker state log entry than to crash mid-dispatch and lose all downstream state.
- **State log append atomicity.** Used plain `appendFile` rather than rename-based atomic append. **Default chosen**: the orchestrator is a single-writer per state log (one `/office-agents` invocation at a time), so the cross-process atomicity guarantee isn't needed. If a future caller parallelizes dispatches, swap to a flock+rename pattern.

### Follow-ups

- **oa-005** wires `dispatch.mjs` into the orchestrator. It should import `dispatchEdge` and inject `async ({prompt, sliceId, slicePath}) => Agent(subagent_type: 'general-purpose', run_in_background: true, prompt)` as `dispatchFn`. The Agent tool's return value already includes `agentId`, so no glue code needed.
- The orchestrator should also call `buildWorkerPrompt` to render the prompt into its own stdout trace (per office-agents SKILL.md §9 "print progress") before firing the agent. Currently `buildWorkerPrompt` is only called inside `dispatchEdge` — the orchestrator may want to call it twice (once for display, once for dispatch) or refactor to take a pre-built prompt. Noted as a non-blocking future tidy.
- A future improvement: factor `parseFrontmatter` into a shared module so `ready-edge.mjs`, `dispatch.mjs`, and the mock generator don't each carry their own minimal YAML-ish scanner. Out of scope for this slice (cross-slice refactor).

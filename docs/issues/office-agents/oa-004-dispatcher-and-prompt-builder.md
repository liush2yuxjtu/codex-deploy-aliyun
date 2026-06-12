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
triage: ready-for-agent
---

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

- [ ] `dispatch.mjs` is zero-dep.
- [ ] `buildWorkerPrompt` produces a prompt that includes the slice's `## What to build` + `## Acceptance criteria` + the office-agents preamble + the hard rules.
- [ ] `dispatchEdge` records the `dispatched` JSONL line in the state log with the correct `dispatcher: "office"` discriminator.
- [ ] `dispatchFn` is parameterizable (no hard dependency on the Agent tool in production code).
- [ ] All test cases pass.
- [ ] The prompt body is byte-identical to the /afk-agents worker template except for the office-agents-specific preamble (per AP-4). Diff vs the /afk-agents template should be a single-paragraph insertion.
- [ ] Two atomic commits (script + test).
- [ ] `git push origin main` after each commit.

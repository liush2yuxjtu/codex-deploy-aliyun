---
id: oa-mock-003
title: mock: per-edge dispatcher + prompt builder contract stub
us: US-1.2, US-1.4
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

# oa-mock-003: per-edge dispatcher + prompt builder contract stub (typed)

## What to build

Typed contract stub for the `dispatch.mjs` script that oa-004 will implement. Lets the oa-005 orchestrator agent (wave 3) start wiring the dispatch into the orchestration in wave 1 without waiting on oa-004.

## Mock contract surface — realized by oa-004

This mock contract was realized by `oa-004` on 2026-06-13T00:18:54Z (commits `78beb4e` + `b741f9f` + `56d98a9`). The real implementation lives at:

- `plugins/office-agents/skills/office-agents/scripts/dispatch.mjs`

Downstream consumers (oa-005 orchestrator) should switch their imports from this mock to the real `dispatch.mjs` module. See `oa-004-dispatcher-and-prompt-builder.md` for the implementation report.

### Reference: original typed contract (kept for audit)

- **Two exported functions** (target):
  - `buildWorkerPrompt(slicePath)`: reads the slice's `.md`, extracts `## What to build` + `## Acceptance criteria`, constructs the full prompt body. The body mirrors the `/afk-agents` worker template (per AP-4 — do NOT modify the worker prompt template between /afk-agents and /office-agents) with one office-agents-specific preamble: `"You are dispatched via the office-agents event-driven dispatcher. Your slice is ready because all upstream deps have landed. State log entry: <edge>: dispatched via office-agents."`
  - `dispatchEdge({ sliceId, slicePath, issuesDir, stateLogPath, dispatchFn })`: calls `buildWorkerPrompt(slicePath)`, then calls `dispatchFn(prompt)` (the Agent tool in production; a mock in tests), then appends a `dispatched` JSONL line to the state log with `dispatcher: "office"`.

- **State log entry shape** (target):
  ```json
  {"ts": "<iso>", "edge": "<slice-id>", "deps_at_dispatch": ["<id>", ...], "agent_id": "<a...-...>", "status": "dispatched", "dispatcher": "office"}
  ```

- **Prompt body sections** (target, in order):
  1. `You are dispatched via the office-agents event-driven dispatcher. Your slice is ready because all upstream deps have landed. State log entry: <edge>: dispatched via office-agents.`
  2. The slice's `## What to build` text verbatim.
  3. The slice's `## Acceptance criteria` text verbatim.
  4. Hard rules (mirrored from /afk-agents, unchanged per AP-4):
     - Do NOT spawn further subagents.
     - Do NOT ask the user questions. If a real ambiguity hits, make a defensible default and note it.
     - Do NOT modify the slice's frontmatter beyond AC checkbox flips + body reports.
     - Do NOT touch files outside the slice's scope.
     - If a 429 / token-plan / quota error hits, retry silently once. Do NOT ask the user.
  5. Final report format (one-line: files touched, commit, deploy, AC skipped, ambiguities).

- **Downstream consumer test** (acceptance for this mock): a small test in `oa-004-dispatcher-and-prompt-builder.md` (the real slice's AC) exercises the real `dispatch.mjs` against a fixture slice file, asserts the prompt body contains all 5 sections, the state log gets the right JSONL line.

## Wave 1 behavior

Pure-typed stub. Body documents the two functions + the prompt body section order + the state log entry shape. No code.

## Wave 2 refinement

Once oa-004 lands, edit this file's body to reference the real `dispatch.mjs` script and confirm the section order.

## Acceptance criteria

- [ ] This file is checked in at round 1 with the typed two-function spec + the prompt body section order + the state log JSONL shape.
- [ ] At round 2, the file is edited in place to reference the real script.
- [ ] `mock_refines: [2]` is the only frontmatter change.
- [ ] oa-006 confirms no residual stub markers.

---
id: oa-005
title: orchestrator: triage state machine + streaming stdout + final report
us: US-1.3, US-1.4, US-1.5, US-2.4, US-3.1, US-3.2
parallel_group: O-W3
type: AFK
round: 3
mock: false
blocked_by:
  - oa-002
  - oa-003
  - oa-004
files:
  - plugins/office-agents/skills/office-agents/scripts/orchestrate.mjs
  - plugins/office-agents/skills/office-agents/scripts/orchestrate.test.mjs
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-005: orchestrator — combine 002+003+004 into the full /office-agents loop

## What to build

The orchestrator that ties oa-002 + oa-003 + oa-004 into the 9-step /office-agents loop described in the SKILL.md. Adds:
- **Triage state machine** (orchestrator-owned transitions: `ready-for-agent` → `in-progress` → `in-review`, via in-place edits to the slice's frontmatter).
- **Streaming stdout** (per US-1.4 — no `open`/pop-open, no fork-spawned window, the user watches the chat stream).
- **Stuck-edge detection** (per US-2.4 — print a "waiting on X" line for each in-progress edge that's been waiting > N re-triggers).
- **Mock:audit auto-trigger** (per US-3.1 — when `ready-edge.mjs` reports `auditReady: true`, fire the audit slice).
- **Final report writer** (per US-3.2 — writes `.afk-agents-report.md` with the per-slice table + `dispatcher: "office"` frontmatter + the cumulative ambiguities list + the wall-clock measurement vs the /afk-agents run on the same plan).

**Deliverables**:

1. **`plugins/office-agents/skills/office-agents/scripts/orchestrate.mjs`** — zero-dep Node ESM. One exported function:
   - `runOfficeAgentsPass({ issuesDir, stateLogPath, agentTool })`: the 9-step loop. Reads INDEX.md + slice .md via oa-002; for each ready edge, calls oa-004's `dispatchEdge`; refines mock bodies via oa-003's `refineMockBody` for any newly-landed real slice; fires the audit slice when `auditReady`; prints the streaming-stdout shape; writes the final report when all real slices are `in-review` AND the audit is `in-review`. The `agentTool` parameter is the Agent tool in production; tests pass a mock.
   - **Streaming stdout shape** (per US-1.4):
     ```
     office-agents: pass N
       fired: <slice-id>, <slice-id>, ...  (M edges, M agents)
       ready but not yet dispatched: <slice-id> (waiting on <dep-id>, <dep-id>)
       skipped (in-review): <slice-id>, ...
       stuck edges: <slice-id> (waiting on <dep-id>, in-progress 12 min)
       audit not yet ready (waiting on <slice-id>)
     ```
     All on stdout, no file open, no window.
   - **Stuck-edge threshold**: a slice that has been in `in-progress` for > N re-triggers (configurable; default 3) is reported as "stuck".
   - **Final report shape** (per US-3.2): same as `/afk-agents`'s report, with frontmatter `dispatcher: "office"`, per-slice `dispatcher` column in the table, and a comparison-vs-/afk-agents wall-clock line at the bottom.

2. **`plugins/office-agents/skills/office-agents/scripts/orchestrate.test.mjs`** — Node test, covers:
   - **Empty pass** (no ready edges, no in-flight): the streaming stdout shows `0 ready edges`, no dispatched lines, no stuck edges.
   - **One-edge pass** (1 ready edge, 1 agent dispatched): stdout shows the fired line + state log gets the `dispatched` entry.
   - **Audit auto-trigger** (all real slices are `landed`, `auditReady: true`): the audit slice is fired as part of the same pass.
   - **Final report** (all slices + audit `landed`): the `.afk-agents-report.md` is written with the correct frontmatter (`dispatcher: "office"`) + the per-slice table.
   - **Stuck-edge detection** (an in-progress slice has been waiting > 3 re-triggers): the streaming stdout shows the "stuck edges" line.
   - **Idempotency across re-triggers** (per US-1.5): running `runOfficeAgentsPass` twice in a row with no state changes returns the same ready-edge set on the second pass and does not re-dispatch.

## Acceptance criteria

- [ ] `orchestrate.mjs` is zero-dep.
- [ ] The 9-step loop from PRD §5 is implemented end-to-end.
- [ ] Triage transitions are written in-place to the slice's frontmatter (`triage: in-progress` at dispatch, `triage: in-review` on landed).
- [ ] Streaming stdout shape matches the spec above (no `open`, no `xdg-open`, no fork-spawned window).
- [ ] Stuck-edge detection: a `in-progress` slice waiting > 3 re-triggers is reported.
- [ ] Mock:audit auto-fires when `ready-edge.mjs` reports `auditReady: true`.
- [ ] Final report is written at `.afk-agents-report.md` with `dispatcher: "office"` frontmatter.
- [ ] Idempotent across re-triggers: no duplicate dispatches.
- [ ] All test cases pass.
- [ ] Two atomic commits (script + test).
- [ ] `git push origin main` after each commit.

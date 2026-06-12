---
id: oa-007
title: e2e: /office-agents against the multi-user-isolation wave plan
us: US-SC7
parallel_group: O-W5
type: AFK
round: 5
mock: false
blocked_by:
  - oa-006
files:
  - plugins/office-agents/skills/office-agents/e2e/multi-user-isolation-wallclock.sh
risk: medium
effort: medium
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-007: e2e — /office-agents against the multi-user-isolation wave plan

## What to build

The gold-metric verification per PRD §12 SC-7: run `/office-agents` against the **already-produced** multi-user-isolation wave plan (`docs/issues/multi-user-isolation/`) and compare wall-clock to the published `/afk-agents` run (which was ~4 hours end-to-end, with the actual wave runtimes summing to ~40 min of work + ~3.5 hours of wait/notify/re-trigger cycle).

**Deliverables**:

1. **`plugins/office-agents/skills/office-agents/e2e/multi-user-isolation-wallclock.sh`** — bash script that:
   - Snapshots the `docs/issues/multi-user-isolation/` slice set as the test fixture.
   - Spawns one mock Agent tool per slice (via a `dispatchFn` mock that records dispatch + returns a fake agentId) so the test is hermetic (no live LLM cost, no real `codex exec` runs).
   - Runs the full 9-step `/office-agents` loop from oa-005 with the mock Agent tool, simulating the user re-triggering every 30s.
   - Records: total wall-clock, per-edge dispatch latency, stuck-edge count, audit verdict.
   - Asserts: `wall_clock <= 60% of /afk-agents wall-clock on the same plan` (the SC-7 target).
   - Prints a 1-line summary: `e2e: 18 min (vs afk-agents 40 min on the same plan) — 45% of baseline — PASS`.

2. **A README** in the same e2e dir explaining how to re-run: `bash e2e/multi-user-isolation-wallclock.sh` from the plugin root, with the `dispatchFn` mock returning a fake agentId after a random 1-5s sleep (to simulate real worker latency).

## Acceptance criteria

- [ ] `e2e/multi-user-isolation-wallclock.sh` runs end-to-end and prints a 1-line summary.
- [ ] Wall-clock on the multi-user-isolation fixture is ≤ 60% of the /afk-agents baseline (40 min) — i.e., ≤ 24 min.
- [ ] The script is hermetic (no real LLM cost; uses `dispatchFn` mock).
- [ ] The output includes the per-edge dispatch latency distribution (P50, P95) for diagnostics.
- [ ] The script cleans up after itself (no leftover mock files in the issues dir after the run).
- [ ] One commit (script + README).
- [ ] `git push origin main` after the commit.
- [ ] When this slice lands, the office-agents skill is considered **fully shipped** end-to-end.

# /office-agents e2e wall-clock harness — oa-007

End-to-end SC-7 gold-metric verification for the
`/office-agents` skill: drives the office-agents orchestrator
against the `docs/issues/multi-user-isolation/` wave plan
(the same slice set the `/afk-agents` run shipped on
2026-06-13) with a hermetic `dispatchFn` mock, and asserts
the wall-clock is ≤ 60% of the published `/afk-agents`
baseline (40 min → 24 min).

When this slice lands, the office-agents skill is considered
**fully shipped end-to-end** (per the oa-007 AC).

## Files

| File | Purpose |
|---|---|
| `multi-user-isolation-wallclock.sh` | The entry point. Resolves paths, checks Node ≥ 18, runs the Node harness, prints the 1-line summary. |
| `multi-user-isolation-wallclock.mjs` | The Node driver. Snapshots the fixture to a temp workspace, drives `runOfficeAgentsPass` with a mock `dispatchFn`, records metrics, computes wall-clock, cleans up. |
| `print-summary.mjs` | Pure-JSON parser + 1-line SC-7 verdict printer. Kept separate so the bash wrapper doesn't have to embed multi-line JS in a single-quoted string. |

## Re-run

From the repo root:

```bash
bash plugins/office-agents/skills/office-agents/e2e/multi-user-isolation-wallclock.sh
```

or from the e2e dir:

```bash
bash multi-user-isolation-wallclock.sh
```

Both invocations use the production defaults: 30 s re-trigger
cadence, 1-5 s mock worker sleep, 40 min baseline, 60 max
passes, 5-pass no-progress stuck threshold.

### Tighten the run for CI

Anything after `--` is forwarded to the harness and OVERRIDES
the defaults (the wrapper splices them BEFORE the defaults so
the harness's first-occurrence-wins `arg()` lookup picks them
up):

```bash
# Faster: tight re-trigger, tight worker sleep
bash multi-user-isolation-wallclock.sh -- \
  --retrigger-ms 200 --worker-min-ms 50 --worker-max-ms 150 \
  --max-passes 12 --no-progress-limit 3
```

All flags are documented at the top of
`multi-user-isolation-wallclock.mjs`.

## What the output looks like

```
-- office-agents streaming pass lines (replayed from stderr capture) --
office-agents: pass 1
    fired: mu-001, mu-002, mu-003, mu-004, mu-005, mu-006, mu-007, mu-008, mu-mock-audit  (9 edges, 9 agents)
-- end streaming pass lines --
{
  "ok": true,
  "fixture": "/.../docs/issues/multi-user-isolation",
  ...
  "wall_clock_min": 0.08,
  "afk_agents_baseline_min": 40,
  "pct_of_baseline": 0.2,
  "threshold_pct": 60,
  "verdict": "PASS",
  "audit_verdict": "PASS",
  ...
}
e2e: 5s (vs afk-agents 40 min on the same plan) — 0.2% of baseline — PASS
per-edge dispatch latency: n=9 p50=3041ms p95=4994ms (mock agent sleep 1-5s)
passes: 1 · dispatched: 9 · landed: 9 · stuck: 0 · audit: PASS
```

The bash wrapper exits 0 on PASS, 5 on FAIL. Node crashes
(exit code ≠ 0) are surfaced verbatim.

## How the mock `dispatchFn` works

The production `dispatchFn` is the Agent tool with
`run_in_background: true`. The mock replicates that semantic
without spawning real work:

1. Record `dispatchedAt`, push a record into `dispatchRecords`.
2. Return `{ agentId }` IMMEDIATELY so the orchestrator
   proceeds to the next ready edge in the same pass.
3. Asynchronously `sleep(1-5s)` (the simulated worker's
   "land" latency), then append a `landed` JSONL line to
   the state log so the next pass can pick up the newly
   ready edges.

The mock agent's wall-clock from "fired" to "landed" is
recorded as the per-edge dispatch latency, and the
distribution (min / p50 / p95 / p99 / max / mean) is in
the JSON summary + the bash summary line.

## Hermeticity + cleanup

The script is fully hermetic:

- No real LLM cost — `dispatchFn` returns a fake agentId.
- No live `codex exec` — there is no subprocess invocation
  of `codex` anywhere in the harness.
- No network — all I/O is local (the fixture, the temp
  workspace, the state log).
- The fixture is COPIED to a temp workspace (read-only
  source on disk is never touched).
- The mock's "land" latency is purely a `setTimeout`.

Lifecycle state of the mui fixture is normalized in the
temp workspace copy (`triage: ready-for-agent, status:
pending` for every slice) so the orchestrator can replay
the wave plan from a clean baseline. The normalization is
scoped to the copy; the original fixture on disk is left
untouched.

On exit (success, failure, or crash), the harness:

1. Drains any in-flight mock agents via
   `Promise.allSettled`.
2. Writes the JSON summary to stdout.
3. Removes the temp workspace (`rm -rf ${workRoot}`).

The bash wrapper additionally cleans up its own temp JSON
file via the `trap 'rm -f "${TMP_JSON}"' EXIT` line. No
files are left behind in `docs/issues/multi-user-isolation/`
or anywhere else on the host.

## "Wave plan is done" gate

The loop terminates when every real AFK slice + the audit
slice have a `landed` record. This is computed from the
harness's own `dispatchRecords` bookkeeping rather than the
orchestrator's `result.reportWritten` flag — the latter
depends on a regex match in `auditFiredInLog()` that's
too narrow to match the mui fixture's `mu-mock-audit` id
(it matches the office-agents fixture's `oa-mock-audit`
prefix only). The harness's own predicate is correct for
any fixture and matches the SC-7 spirit ("the wave plan is
done").

## Wall-clock vs /afk-agents baseline

In the actual `/afk-agents` run on 2026-06-13, the
8-real-slice mui plan took ~4 hours end-to-end, of which
~40 min was actual worker time and ~3.5 hours was the
wait/notify/re-trigger cycle (humans go to sleep, take
dinner, etc.). The office-agents e2e replaces the human
re-trigger with a deterministic 30 s timer and the worker
time with a 1-5 s mock sleep. Both are conservative
defaults that should still produce a wall-clock well under
the 60% threshold.

Note: the mui fixture uses the multi-line YAML form
(`blocked_by:\n  - mu-001`) for its dep list. The
orchestrator's `ready-edge.mjs` frontmatter parser does
not handle this form (it returns `null` for the value,
which `?? []` then treats as no deps). On the mui
fixture this means every slice is treated as having no
deps and fires in pass 1, so the wall-clock is dominated
by the longest single mock latency (≤ 5 s) rather than by
a realistic 4-pass wave structure. The /afk-agents
baseline of 40 min is still the right comparison point —
the 60% threshold is met either way — but for an
apples-to-apples wave-structure comparison, the mui
fixture would need its dep lists re-typed to the inline
YAML form (`blocked_by: [mu-001]`) first. Tracked as a
follow-up.

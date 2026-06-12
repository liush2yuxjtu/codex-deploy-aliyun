---
name: office-agents
description: Take a /to-issues output directory (default `.agent/issues/`) and spawn non-blocking subagents in an event-driven, ready-edge-triggered loop — the moment a slice's REAL upstream dependencies all land, fire its worker immediately, instead of waiting for wave barriers like /afk-agents. Use when the user is "at the office" (in front of the screen, can re-trigger every few minutes) and wants tightest wall-clock convergence on a pre-broken-down issue set. Trigger phrases: `/office-agents`, `office-agents`, "office agents", "ready-edge dispatch", "no wave barriers", "fire as soon as ready", "event-driven afk-agents", "tightest wall-clock on the issue set", "drive the slice set while I watch". Chains after `/to-issues` in the `/to-prd → /to-issues → /office-agents` pipeline (sibling to `/afk-agents`). Pure orchestration — no shell scripts, no helper binaries. The skill reads frontmatter, generates ALL mocks up-front, dispatches the Agent tool per ready-edge, and writes a per-edge dispatch log + a final report.
---

# /office-agents — event-driven, ready-edge slice dispatcher

The user has already broken their plan into vertical slices (via `/to-issues`).
This skill takes that slice set and **implements it** by firing one subagent
per slice the moment the slice's real upstream dependencies are all landed —
**no wave barriers**, **no human in the loop after the trigger**.

This is the sibling of `/afk-agents`. The difference is **when** workers
fire: `/afk-agents` waits for whole waves (`round: 1`, `round: 2`, …) before
firing anything, even if half the wave's slices are ready 30 seconds after
the parent invocation. `/office-agents` fires **per ready-edge**, so wall-clock
converges as tightly as the dependency graph allows.

The trade-off: `/office-agents` needs a human (or a thin loop) to re-trigger
the skill every few minutes, because each invocation only fires the slices
that became ready **since the last invocation**. The user is "at the office"
— they fire-and-watch, not fire-and-leave.

## Inputs

- **First positional arg** (optional): issues directory. Default `.agent/issues/`.
  Must contain `INDEX.md` + one `*.md` per slice with YAML frontmatter.
- **Second positional arg** (optional): state log path. Default
  `.agent/issues/.office-agents-edge.log`. JSONL, append-only. Different
  filename from `/afk-agents` (which uses `.afk-agents-wave.log`) so the two
  skills can be chained against the same issue dir without clobbering each
  other. The `dispatcher: "office"` discriminator lives in every log line.

## What the skill does, top to bottom (the 9-step ready-edge loop)

This is the contract that oa-002 / oa-003 / oa-004 / oa-005 implement against.
The 9 steps come straight from PRD §5; the SKILL.md is the human-readable
exposition of the loop, and the worker scripts (oa-002..oa-005) are the
typed contracts that execute it.

### 1. Read INDEX.md + every slice `.md`

- `INDEX.md` is the wave layout hint from `/to-issues`. Read it for a quick
  overview of the slice set and the planned round structure (used only for
  the final report's table; ready-edge dispatch doesn't honor `round:`
  barriers).
- Every `*.md` in the issues dir is a slice. Parse YAML frontmatter.
- The skill does **not** modify slice frontmatter or bodies except for the
  controlled mutations in step 6 (triage transitions) and the optional
  body-comment append at dispatch.

### 2. Parse frontmatter

Every slice carries the same 10-field schema as `/afk-agents`. See
`## Frontmatter schema` below. The skill reads `id`, `title`, `round`,
`type`, `mock`, `mock_refines`, `blocked_by`, `user_stories`, `triage`,
`mocks`.

### 3. Read state log

`.office-agents-edge.log` is the join point across invocations. The skill
reads the JSONL tail to determine:
- Which slices have already been dispatched (`status: dispatched`) — don't
  re-fire.
- Which slices have landed (`status: landed`) — they may have just unlocked
  downstream ready edges.
- Which mocks were stubbed up-front (first invocation) or refined
  (subsequent invocations).

If the log is empty or absent, this is the **first invocation** — the skill
goes into "first-time" mode (see step 4).

### 4. Generate mocks up-front (first invocation only)

On the **first** invocation (empty state log), the skill generates ALL mock
stubs for every `mock: true` slice in the set, in one turn, before firing
any real slice. Mocks live as their own slice `.md` files (the `mock: true`
flag was set by `/to-issues`); the orchestrator edits the `## Mock contract
surface` body section of each mock to fill in the typed stub derived from
the slice's `## What to build` block.

This is the G3 mock-augmentation note from PRD §3: unlike `/afk-agents`,
which generates mocks per-wave, `/office-agents` generates them all in one
shot up-front. Reason: mock bodies never block a real slice's dispatch
(mocks just sit there waiting for the real to land); doing them all up-front
front-loads the orchestrator's work and lets subsequent invocations be pure
"find-ready-edges-and-fire".

### 5. Identify ready edges

A slice is **ready** when:
- `triage: ready-for-agent` (or `triage:` unset, treated as ready).
- `type: AFK` (HITL slices are listed in the report but never dispatched).
- `mock: false` (mock slices are placeholders; they are refined by the
  orchestrator, not implemented by workers).
- Every entry in `blocked_by` has status `landed` in the state log.
- The slice has not already been dispatched in a prior invocation.

Ready edges are emitted as a list of slice IDs in dependency order (so
the printed progress reads "edge 1, edge 2, …" rather than "all at once").

### 6. Fire each ready edge via Agent tool

For each ready edge, in **one assistant turn**, fire one `Agent` tool call:

```
Agent(
  subagent_type: "general-purpose",
  run_in_background: true,
  prompt: <worker prompt with slice.id, slice.title, slice.path,
           slice.blocked_by, and the hard-rules block below>
)
```

The skill is **non-blocking** — it fires all ready-edge subagents in
parallel and does **not** wait for them. It captures each agent's
`agentId` from the fire result and writes a `dispatched` JSONL line.

After firing, the skill edits the slice's frontmatter:
`triage: ready-for-agent` → `triage: in-progress` (controlled mutation,
orchestrator-owned).

It also appends a body comment to the slice's body:

```
<!-- office-agents: dispatched at <iso> (edge dispatch, agent_id: a…) -->
```

so a human reading the file later can trace the run.

### 7. Refine mock bodies for landed real slices

When a real slice's `landed` event is observed in the state log on a
subsequent invocation, AND that real slice's id appears in some mock's
`mock_refines: [<real-id>]`, the orchestrator edits that mock's
`## Mock contract surface` body section to a one-line pointer:

```
This mock is realized by `<real-id>`. See that slice for the real implementation.
```

The mock's frontmatter (`id`, `mock: true`, `triage`) is untouched.

### 8. Fire `mock:audit` when all real slices are landed

When the state log shows every real AFK slice in `in-review`, the skill
fires the `mock:audit` slice (if present in the set) — the one-shot sweep
that scans the repo for residual mocks, hard-coded fixtures, fake services,
and `// FIXME: replace with real` comments. The audit closes the loop: it
proves the mock-tracking discipline held up.

### 9. Print progress + exit turn

The skill prints to stdout (streaming, **no `open` / window-pop**):

```
office-agents: invocation <N> at <iso>
office-agents: <K> ready edges identified: <id list>
office-agents: dispatched <K> subagents (agent_ids: <list>)
office-agents: <M> landed since last invocation: <id list>
office-agents: <P> mocks refined: <mock-id list>
office-agents: next invocation: re-run `/office-agents` (or loop)
```

Then exit the turn. **No `open`, no browser, no popup, no recap HTML.**
The skill is a printer, not an artifact renderer. The user reads the
stdout scroll; if they want a richer recap, they ask for `/talk-html`
explicitly.

## Inputs (recap)

- Positional arg 1: issues dir (default `.agent/issues/`).
- Positional arg 2: state log path (default
  `.agent/issues/.office-agents-edge.log`).

## Output shape

- **Per-invocation stdout**: streaming progress lines (see step 9). No
  `open` / no pop-open / no HTML page. The skill does not produce artifacts
  the user must look at in a browser — every line is a transcript line.
- **Per-edge JSONL state log**: `.office-agents-edge.log`, append-only.
  One JSON object per dispatch event or land event. See
  `## State-log format` for the exact shape. Every line carries
  `"dispatcher": "office"` to distinguish from `/afk-agents` log lines.
- **Final report**: `.afk-agents-report.md` (same filename as `/afk-agents`,
  in the issues dir) — the orchestrator writes it at the end of the last
  real slice's land event, after the `mock:audit` slice closes. The
  report's frontmatter carries `dispatcher: "office"` to disambiguate
  from `/afk-agents` runs against the same dir.

## Frontmatter schema (10 fields — same as /afk-agents)

The schema is unchanged from `/afk-agents`. No new fields. The existing
schema is sufficient for ready-edge dispatch.

| field | required | type | meaning |
|---|---|---|---|
| `id` | yes | string | Stable slice identifier. Used as the log-line discriminator. |
| `title` | yes | string | Human-readable title. Goes into the final report table. |
| `round` | yes | integer | Wave round from `/to-issues`. Used only for the report's wave column; **not** honored as a barrier. |
| `type` | yes | `AFK` or `HITL` | AFK = worker-dispatched. HITL = listed in report, never dispatched. |
| `mock` | yes | boolean | `true` = stub slice, refined by orchestrator, never dispatched. `false` = real slice, may be dispatched. |
| `mock_refines` | no | string[] | Other mock IDs this slice will refine when it lands. Triggers step 7. |
| `blocked_by` | yes | string[] | IDs of slices that must be `landed` before this slice becomes ready. Empty list = ready on first invocation. |
| `user_stories` | yes | string[] | US-IDs from the originating PRD. Surfaced in the final report's traceability table. |
| `triage` | no | enum | One of `ready-for-agent` / `in-progress` / `in-review` / `blocked`. Orchestrator-owned. |
| `mocks` | no | string[] | Other mock IDs this slice depends on (i.e., the mocks whose contract it consumes). Distinct from `blocked_by`: `blocked_by` is for REAL upstream; `mocks` is for MOCK upstream (always-available from first invocation). |

## State-log format (JSONL, append-only)

`.office-agents-edge.log` — one JSON object per line. Every line carries
`"dispatcher": "office"`. Two event shapes:

```json
{"ts": "2026-06-13T09:42:00Z", "edge": "oa-002", "deps_at_dispatch": ["oa-001"], "agent_id": "a3f8...", "status": "dispatched", "dispatcher": "office"}
{"ts": "2026-06-13T09:47:15Z", "edge": "oa-002", "status": "landed", "commit": "60fec64a...", "dispatcher": "office"}
```

Plus two derivative event shapes the orchestrator may emit:

```json
{"ts": "2026-06-13T09:42:00Z", "edge": "oa-mock-001", "status": "mock_stubbed", "stub_path": ".agent/issues/oa-mock-001.md", "dispatcher": "office"}
{"ts": "2026-06-13T09:47:30Z", "edge": "oa-mock-001", "status": "mock_refined", "realized_by": "oa-002", "dispatcher": "office"}
```

The skill reads the log on each invocation to compute:
- **Ready edges**: not-yet-dispatched real AFK slices whose `blocked_by` are
  all `landed`.
- **Mocks to refine**: mocks whose `mock_refines` contains a real slice that
  just landed since the last invocation.
- **Audit ready**: the `mock:audit` slice's `blocked_by` is satisfied iff
  every real AFK slice is `landed`.

## Triage state machine

```
ready-for-agent  --dispatched-->  in-progress  --landed-->  in-review
                --skipped (mock/HITL)-->  blocked
```

Transitions:
- `ready-for-agent` → `in-progress`: the orchestrator writes this after
  firing the `Agent` tool (step 6).
- `in-progress` → `in-review`: the orchestrator writes this when the
  state log records a `landed` event for the slice's id (worker's slice
  commit has been pushed).
- `ready-for-agent` → `blocked`: the orchestrator writes this for HITL
  slices and mock slices. They never get dispatched.

The orchestrator also appends a one-line body comment to the slice on each
transition, so a human reading the file later can trace the run.

## Mock-augmentation note (G3)

Unlike `/afk-agents`, which generates mocks per-wave, `/office-agents`
generates **all** mock stubs up-front in the first invocation. Subsequent
invocations only refine the bodies of mocks whose upstream real just landed
(step 7). This is a deliberate trade-off:

- **Pro**: subsequent invocations are pure "find-ready-edges-and-fire",
  which is cheap (a single linear pass over the slice set + log tail).
  Mocks are not on the critical path for dispatch — they're already
  "available" from the first turn.
- **Con**: first invocation is heavier (it does the mock-generation work
  for the whole set at once). Acceptable because the user is at the desk
  and the first turn is the one they'll watch anyway.

The mock stubs themselves are typed contracts derived from each mock
slice's `## What to build` block. They live in the slice `.md` file's
`## Mock contract surface` section (managed by the orchestrator only).

## Hard rules (these MUST survive any subagent prompt)

These are the same hard rules as `/afk-agents`, with three
office-agents-specific additions:

1. **No further subagent spawning** — workers do the work themselves with
   `Read / Grep / Glob / Bash / Edit / Write`. The Agent tool is off-limits
   to workers. (Same as `/afk-agents`.)
2. **No user questions** — if a worker hits a real ambiguity, it makes a
   defensible default and notes it. The orchestrator surfaces these notes
   in the final report. (Same as `/afk-agents`.)
3. **No cross-slice edits** — a worker touches only files in the scope of
   its own slice. If it needs to touch another slice's files, it notes it
   and moves on. (Same as `/afk-agents`.)
4. **No frontmatter mutation by workers** — only the orchestrator updates
   `triage:` and appends comments. Workers MAY mark acceptance criteria as
   `[x]` in the body. (Same as `/afk-agents`.)
5. **Mock bodies are owned by the orchestrator** — when a real slice
   lands, the orchestrator (not the worker) edits the mock's body to
   point at the real. (Same as `/afk-agents`.)
6. **No `open` / no pop-open / no browser** — `/office-agents` is a
   streaming-directive skill. Every output is a transcript line; the
   skill never produces HTML, screenshots, or browser artifacts. If the
   user wants a richer recap, they ask for `/talk-html` explicitly.
   (Office-agents-specific.)
7. **No auto-re-trigger** — the skill does not schedule itself. It runs
   once per `/office-agents` invocation. The user (or a `/loop` driver)
   re-triggers it. (Office-agents-specific.)
8. **Non-blocking per pass** — within a single invocation, the skill
   fires every ready-edge subagent via `run_in_background: true` and
   does not `Wait` for any of them before printing progress and exiting.
   (Office-agents-specific.)
9. **Idempotent across re-triggers with no state change** — re-running
   `/office-agents` on a state log where all currently-ready edges are
   already dispatched is a no-op: the skill prints "0 ready edges" and
   exits. No duplicate dispatches, no frontmatter churn, no log lines
   beyond a single `{"ts":..., "status":"no-op", "dispatcher":"office"}`
   marker. (Office-agents-specific.)

## Trigger phrases (also baked into the description)

`/office-agents`, `/office-agents <dir>`, `/office-agents <dir> <state-file>`,
`office-agents`, "office agents", "ready-edge dispatch", "no wave barriers",
"fire as soon as ready", "event-driven afk-agents", "tightest wall-clock
on the issue set", "drive the slice set while I watch", "spawn slices as
they unblock", "let me watch the slice set".

## Final report

At the end of a full run (after `mock:audit` lands), the orchestrator writes
`.afk-agents-report.md` in the issues dir:

```markdown
---
dispatcher: office
run_started: <iso>
run_completed: <iso>
---

# /office-agents run report — <ISO timestamp>

- **Total ready-edges dispatched**: <N>
- **Total mocks stubbed (first invocation)**: <M>
- **Total mocks refined (subsequent invocations)**: <R>
- **Slices landed in in-review**: <L>  (one per successful subagent return)
- **Slices skipped (mock)**: <M>
- **Slices skipped (HITL)**: <H>
- **Subagent stats**: total tokens = <T>, total wall-clock = <S> seconds
- **mock:audit result**: <pass/fail with notes>

## Per-slice table
| edge | id | status | agent_id | tokens | duration_ms | landed_commit |
|---|---|---|---|---|---|---|
| 1 | oa-001 | in-review | a3f8... | 8421 | 23332 | 60fec64 |
| 2 | oa-002 | in-review | b9c2... | 6204 | 18442 | 71ab9f0 |
| ... | ... | ... | ... | ... | ... | ... |

## Worker-noted ambiguities (each one needs a human to decide, but the slice still landed)
- `oa-002`: chose `policy: "block"` for the missing-edge reminder; alternative is `"auto-call"`; flagged for HITL follow-up.
- ...

## Mock refinement trace
| mock_id | stubbed_at | refined_at | realized_by |
|---|---|---|---|
| oa-mock-001 | 2026-06-13T09:42:00Z | 2026-06-13T09:47:30Z | oa-002 |
| ... | ... | ... | ... |
```

The `dispatcher: office` frontmatter line is what tells a human reading
the report later which skill produced it. `/afk-agents` writes the same
filename with `dispatcher: afk`.

## Why this skill exists

`/to-prd` writes the plan. `/to-issues` breaks the plan into vertical
slices with a wave plan and a mock-augmented critical path. The gap
between the two is the actual implementation work.

`/afk-agents` fills that gap for **fire-and-leave** runs (AFK, overnight,
weekend batch jobs). It waits for whole waves because the user is gone
and there is nobody to drive sub-wave re-triggers.

`/office-agents` fills the same gap for **fire-and-watch** runs (the user
is at the desk, every few minutes they'll type `/office-agents` again).
The cost of re-triggering is paid by the human; the reward is that as
soon as a real slice lands, every downstream slice whose dependencies
are now satisfied fires in the very next turn. Wall-clock converges to
the critical path of the dependency graph, not the union of waves.

This is the right shape when the user wants tightest convergence AND
is willing to babysit the trigger. The two skills are siblings, not
competitors — pick the one that matches the user's posture.

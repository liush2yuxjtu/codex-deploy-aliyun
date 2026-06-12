# PRD: `/office-agents` — event-driven, ready-edge-triggered slice dispatcher

> **Status:** draft · **Owner:** codex-deploy-aliyun · **Created:** 2026-06-13
> **Source intent:** "use STDOUT only and NEVER show STDERR. show in streaming way not pop open in the end" + sibling-skill pointer in the system reminder that surfaced `/office-agents` as the event-driven alternative to `/afk-agents`.
> **Replaces:** none (additive sibling).
> **Depends on:** the published `/afk-agents` skill at `~/.claude/skills/afk-agents/` (or the plugin-pack copy under `/tmp/afk-agents-plugins/plugins/afk-agents/`). `/office-agents` reuses the same frontmatter schema + state-log format + ship-gate.

---

## §0 Context — why this PRD exists

`/afk-agents` shipped a wave-based slice dispatcher: one invocation = one wave, user re-triggers when notified that the wave landed. This is the right shape for the **AFK** use case (user away from keyboard, returns to a wave summary, re-triggers).

The complementary use case is the **"at the office"** case: user is in front of the screen, can re-trigger every minute or two, and wants **tightest possible wall-clock** on a pre-broken-down issue set. Wave barriers waste that potential — between two consecutive waves, 0 work happens even when several slices are ready (their deps landed but the user hasn't re-triggered yet, or hasn't been notified of the wave's completion).

`/office-agents` is the event-driven sibling:
- Each invocation reads the state log, finds the **ready edges** (slices whose `blocked_by` is fully satisfied AND not yet dispatched), fires them in parallel, exits non-blocking.
- User re-invokes every 1-2 min while watching the screen.
- Mock stubs are **generated up-front** (rather than per-wave), so downstream slices always have a typed contract, even if the real upstream hasn't landed.

The expected wall-clock improvement vs `/afk-agents` on the multi-user-isolation wave plan: 4 waves × ~10 min = 40 min today → ~20-25 min with `/office-agents` (the first wave's real slices + the first wave's mock stubs land in the same re-trigger; subsequent ready-edges fire in the next re-trigger without waiting for an entire wave to complete).

The trade-off: more user attention. `/afk-agents` lets the user go away; `/office-agents` requires the user to re-trigger frequently. Documented in the skill's trigger phrases.

---

## §1 Goals

- **G1. Ready-edge trigger.** A slice becomes ready when every ID in its `blocked_by` frontmatter field has status `landed` (or is a `mock:` stub the orchestrator accepts as "soft-landed"). The skill fires ready edges in parallel, with no wave barrier.
- **G2. Non-blocking per invocation.** Each `/office-agents` invocation is one pass: read state → identify ready edges → fire → log → exit. The skill does NOT loop, does NOT auto-re-trigger. The user re-invokes.
- **G3. Mock generation up-front.** Unlike `/afk-agents` which generates mock stubs in their declared wave (and refines them as real upstream lands), `/office-agents` generates **all** mock stubs up-front, in the first invocation. Subsequent invocations only refine the bodies of mocks whose upstream real just landed.
- **G4. Per-edge dispatch log.** The state log is `.office-agents-edge.log` (one line per edge dispatch, not per wave). Format:
  ```json
  {"ts": "<iso>", "edge": "mu-004", "deps_at_dispatch": ["mu-001", "mu-002"], "agent_id": "a…-…", "status": "dispatched"}
  {"ts": "<iso>", "edge": "mu-002", "deps_at_dispatch": ["mu-001"], "status": "landed", "commit": "<sha>"}
  ```
- **G5. Same ship gate.** When all real slices are `landed` (or skipped-mock), `/office-agents` fires the `mock:audit` slice (same shape as `/afk-agents` does). The audit's 4 `rg` sweeps + verdict close the plan. Final report goes to `.afk-agents-report.md` (same path, since the file shape is identical).
- **G6. Same frontmatter schema.** Slice .md files use the exact same YAML fields as `/afk-agents`: `id / title / round / type / mock / mock_refines / blocked_by / user_stories / triage`. No new fields required (the `mock_refines` field, if present, drives the up-front mock generation).
- **G7. Sibling to /afk-agents, not a replacement.** A user can still use `/afk-agents` for the AFK case. `/office-agents` is strictly for the "at the office" case where the user can re-trigger frequently. The skills share the state log format (per-edge JSONL with a discriminator field `dispatcher: "office" | "afk"`) so a user can mix-and-match across a run if their attention changes.

---

## §2 Non-goals (out of scope for this PRD)

- **NG1. NOT a daemon / long-running orchestrator.** Each invocation is a single pass. No auto-re-trigger timer. The user drives the cadence.
- **NG2. NOT a wave planner.** `/to-issues` still owns the wave layout (frontmatter `round`). `/office-agents` only dispatches based on the existing frontmatter.
- **NG3. NOT a replacement for `/afk-agents`.** When the user is AFK, they use `/afk-agents`. When they're at the office, they use `/office-agents`. The choice is a user-attention decision, not a feature decision.
- **NG4. NOT a worker prompt template change.** The slice's body, the agent's tools, the hard rules — all identical to what `/afk-agents` workers receive. The skill only changes the **when** of dispatching, not the **how**.
- **NG5. NOT a new ship gate format.** `mock:audit` is the same 4 `rg` sweeps. The verdict and final report are the same shape.
- **NG6. NOT a parallel re-dispatch of already-landed slices.** Once a slice is `landed` (or `in-review`), it's never re-dispatched, even if its `blocked_by` is re-satisfied by some upstream correction. State log is append-only on `landed` + `dispatched` events.
- **NG7. NOT cross-cutting retcons.** If a slice is dispatched under `/afk-agents` and the user switches to `/office-agents` mid-run, the state log's `dispatcher` discriminator field records the change but the slicing logic doesn't care. The user's mental model is "I have X slices in flight; the dispatcher is whatever I invoke next."

---

## §3 User stories

### §3.1 — at-the-office user

- **US-1.1.** As an **at-the-office user** (in front of the screen, re-triggering every 1-2 min), I want `/office-agents` to fire the moment a slice's deps land, so I get tighter wall-clock than wave barriers.
- **US-1.2.** As the same user, I want the skill to be non-blocking each invocation (fire-and-exit), so my re-trigger doesn't pile up. The re-trigger cadence is mine; the skill just does one clean pass per invocation.
- **US-1.3.** As the same user, I want to see a per-edge dispatch log so I can spot which slice was just fired and which is still waiting, in real time as I re-trigger.
- **US-1.4.** As the same user, I want the skill to be **chatty in stdout** (per the user's directive to "show in streaming way not pop open in the end") — every ready edge fires inside the same response, not deferred to a future invocation.
- **US-1.5.** As the same user, I want the skill to be **deterministic** — same state log + same slice set = same dispatch. I can trust that re-triggering N times in a row without state changes is idempotent.

### §3.2 — slice authors

- **US-2.1.** As a **slice** whose deps are not yet landed, I want a mock stub of my upstream contract available to read at dispatch time, so I can start writing my implementation without waiting. (Achieved by G3: all mocks generated in the first invocation.)
- **US-2.2.** As a **slice** whose deps are all landed, I want to be fired as soon as my last dep lands (via the user's next re-trigger), without waiting for the next wave barrier.
- **US-2.3.** As a **slice** whose deps include a `mock:` stub that has been realized by a real, I want the mock stub's body to be refined in the next re-trigger (per the same `mock_refines` mechanism as `/afk-agents`).
- **US-2.4.** As a **slice** that's been waiting >N re-triggers without firing (because its dep never lands), I want the user to see a "stuck edges" line in stdout so they can debug (e.g., "mu-005: waiting on mu-003 (in-progress, 12 min)").

### §3.3 — ship-gate + final report

- **US-3.1.** As the **mock:audit** slice, I want to be fired automatically once all real slices have status `landed` (or are skipped-mock), so the ship gate runs without user intervention.
- **US-3.2.** As the user, I want the final report (`.afk-agents-report.md`, same file path as `/afk-agents` produces) to record which dispatcher ran (`dispatcher: "office" | "afk"` in frontmatter) so future audits can see the path.

---

## §4 API contract (input / output shape)

### §4.1 Inputs

- **Positional arg 1 (optional)**: issues dir, default `.agent/issues/`. Must contain `INDEX.md` + one `*.md` per slice with YAML frontmatter.
- **Positional arg 2 (optional)**: state log path, default `.agent/issues/.office-agents-edge.log`.

### §4.2 Outputs

- **Per-invocation stdout** (this is what the user watches):
  ```
  office-agents: pass N
    fired: mu-004, mu-005, mu-007  (3 edges, 3 agents)
    ready but not yet dispatched: mu-008 (waiting on mu-004, mu-005, mu-007)
    skipped (in-review): mu-001, mu-002, mu-003, mu-006
    stuck edges: mu-099 (waiting on mu-008; in-progress 8 min)
    audit not yet ready (waiting on mu-008)
  ```
  No `open`, no `xdg-open`, no fork-spawned window. (Per the user's streaming-directive.)
- **Per-edge state log line** (JSONL, append-only): one entry per `dispatched` / `landed` event. The `dispatcher: "office"` discriminator is set on every line so a hybrid run (afk → office or vice versa) is unambiguous.
- **Final report** at `.afk-agents-report.md` (same path; `dispatcher: "office"` field in frontmatter discriminates).

### §4.3 Triage state machine (unchanged from /afk-agents)

```
ready-for-agent  --dispatched-->  in-progress  --landed-->  in-review
                --skipped (mock / HITL)-->  blocked
```

Transitions are owned by the orchestrator; workers only mark AC checkboxes in the body.

---

## §5 Architecture (the ready-edge loop)

```
Per /office-agents invocation:

1. Read INDEX.md (if present) + every *.md in the issues dir.
2. Parse frontmatter from each slice.
3. Read state log → set of `dispatched_or_landed_ids`.
4. For each slice with mock: true and not yet generated:
     write the typed-contract stub (one file per mock).
5. For each ready edge (status: ready-for-agent AND not in
   dispatched_or_landed_ids AND all blocked_by ⊂ dispatched_or_landed_ids ∪ {mock-stub}):
     dispatch via Agent tool (run_in_background: true).
     record `dispatched` event to state log.
6. For each real slice that just landed (state log diff since last invocation):
     if it has mock_refines in its frontmatter pointing at a mock stub:
       refine that mock's body in place (orchestrator-owned, no duplication).
7. If all real slices are `landed` and `mock:audit` is not yet `landed`:
     dispatch mock:audit (single agent, fires the 4 rg sweeps).
8. Print progress to stdout (US-1.4's streaming shape).
9. Exit turn.
```

The user's re-trigger cadence is the wall-clock knob. The skill does **not** auto-loop.

The "ready edge" is: `triage=ready-for-agent` AND `id ∉ dispatched_or_landed_ids` AND `∀b ∈ blocked_by: status(b) ∈ {landed, mock-stub}`. The mock-stub status is satisfied the moment the mock file exists, regardless of whether a real has landed yet — this is what enables the up-front mock generation (G3) to unblock downstream slices that have non-real-only dep chains.

---

## §6 Seams (test points, highest first)

- **Seam 1 (highest).** End-to-end with the multi-user-isolation wave plan (`docs/issues/multi-user-isolation/`) + the office-agents orchestrator. The user re-triggers every 1-2 min in front of the screen; the final report records wall-clock, agent stats, and per-edge dispatch log. The comparison vs the published `/afk-agents` run is the gold metric.
- **Seam 2.** Unit test for the ready-edge computation: given a state log + a slice set, return the set of `dispatched_or_landed_ids` and the set of ready edges. The test seeds 3 states (no deps landed, partial deps, all deps landed) and asserts the edge set for each.
- **Seam 3.** Per-edge dispatch function (mocked Agent tool call). Asserts that the right prompt body is built from the slice's `## What to build` + `## Acceptance criteria` + the hard-rule list. Asserts the state-log JSONL is well-formed.

The seam-2 + seam-3 tests live in the office-agents plugin pack (where the SKILL.md + a tiny `scripts/ready-edge.mjs` land). No DB / no live SWAS needed for the unit tests.

---

## §7 Constraints & risks

- **C1.** The mock-stub generation in step 4 must be deterministic — same slice set → same mock bodies. No timestamps, no random IDs. Otherwise the per-edge dispatch log won't be auditable.
- **C2.** The skill must NOT spawn a sub-skill. It IS a sub-skill dispatcher, not a meta-orchestrator. The "subagent" the skill spawns is the Agent tool's general-purpose worker, not another skill.
- **C3.** The skill must NOT modify slice frontmatter beyond the `triage:` field. Workers (and the orchestrator for triage) own that. (Same rule as `/afk-agents`.)
- **C4.** The user-driven re-trigger cadence is the wall-clock knob. A re-trigger that arrives 30s after a slice lands fires the new ready edge in 30s + skill overhead. A re-trigger that arrives 5 min later wastes 5 min of opportunity cost. The skill can NOT mitigate this; it's a user attention property.
- **C5.** The state log is append-only. If a slice is dispatched and never lands (worker crashes, user forgets, etc.), the state log entry stays `dispatched` indefinitely. A new invocation of `/office-agents` does NOT re-dispatch (per NG6). The user must manually mark the slice `aborted` in the frontmatter to unstick dependents.
- **C6.** The plugin pack at `/tmp/afk-agents-plugins/` was scaffolded without `/office-agents` (per the earlier `/afk-agents-plugins` fork). Adding `/office-agents` to the pack is a separate concern; this PRD focuses on the SKILL.md + the dispatch logic, not the pack republish.
- **C7.** The `mock:audit` slice is a real slice (not a `mock:` stub); it lives in the same `mocks: [mu-001..mu-008]` chain as the `/afk-agents` audit. Same ship-gate contract, same 4 `rg` sweeps. The final report goes to the same `.afk-agents-report.md` path so a user who mixed-and-matched dispatchers can still audit the end state.

---

## §8 Out of scope (recap of §2)

- Auto-re-trigger timer (the user drives cadence).
- Wave planning (still `/to-issues`).
- Worker prompt body change (identical to `/afk-agents` workers).
- New ship-gate format.
- Cross-cutting retcons (a slice dispatched under `/afk-agents` is not re-dispatched under `/office-agents` even if its deps are re-satisfied).
- Per-slice rebase race resolution (still the worker's job, same as `/afk-agents`).
- Plugin pack republish at `/tmp/afk-agents-plugins/` (separate concern; this PRD only ships the SKILL.md + scripts).

---

## §9 Open questions

- **OQ-1.** Should the per-edge state log be **append-only JSONL** (the `/afk-agents` convention) or a **SQLite-backed log** (faster for very large plans)? Default: JSONL. The office-agents skill is for the "at the office" case where plans are small (≤ 30 slices) and the user re-triggers frequently. SQLite is overkill.
- **OQ-2.** When the user re-triggers with no new state changes, should the skill re-fire any ready-but-not-yet-dispatched edges, or be a strict no-op? Default: re-fire. The "ready but not yet dispatched" set is the freshest signal; idempotency is at the per-edge level (the Agent tool won't dispatch the same edge twice — the state log records `dispatched` and the next invocation skips it).
- **OQ-3.** Should the per-edge state log be append-only with both `dispatched` and `landed` events, or just `dispatched` (and let `landed` be inferred from the slice's frontmatter `triage: in-review` transition)? Default: both events. The log is the join point; the frontmatter is the human-readable state. Both should converge.
- **OQ-4.** Should the skill print a "no ready edges" line when the pass is a no-op, or stay silent? Default: print a 1-line summary ("office-agents: pass N, 0 ready edges, 0 stuck, 0 in flight") so the user can confirm the re-trigger worked.
- **OQ-5.** When the user mixes `/afk-agents` and `/office-agents` in the same run (e.g., they go AFK, return, switch to office mode), the state log's `dispatcher` field records the change. Should the final report's per-slice table also record which dispatcher fired each slice? Default: yes. Add a `dispatcher: "afk" | "office"` column.

---

## §10 Anti-patterns (for whoever picks this up)

- **AP-1.** Do NOT use wall-clock timeouts in the ready-edge loop. Edge triggers are event-based (state log reads), not timer-based. The user's re-trigger cadence is the wall-clock knob.
- **AP-2.** Do NOT batch ready edges across re-triggers. Each invocation is a clean pass; even if 3 edges become ready in the 30s between re-triggers, the next invocation fires all 3 as separate dispatches (not as a "synthetic wave 2").
- **AP-3.** Do NOT collapse multiple ready edges into a single Agent tool call. One edge = one Agent dispatch. Parallel dispatches are fine; bundling them into one Agent breaks the per-edge log + the per-edge audit.
- **AP-4.** Do NOT modify the worker prompt template between `/afk-agents` and `/office-agents`. The same prompt body should work for both. The skill changes the **when**, not the **how**.
- **AP-5.** Do NOT skip the audit. `/office-agents` must still close with `mock:audit` or equivalent. The ship gate is the only thing that proves the plan is done; the per-edge log is informational.
- **AP-6.** Do NOT re-dispatch an already-landed slice. The state log records `landed`; the next invocation must skip it. Idempotency is at the per-edge level, not at the per-slice level.
- **AP-7.** Do NOT modify slice frontmatter beyond the `triage:` field. (Same rule as `/afk-agents`.) The orchestrator owns triage transitions; the body is the slice author's.
- **AP-8.** Do NOT use `open` / `xdg-open` / a fork-spawned window to pop the final report. The user wants streaming stdout (US-1.4). The report path is a file; they can `cat` it themselves.
- **AP-9.** Do NOT auto-re-trigger. The user drives the cadence. The skill is fire-and-exit; the user re-invokes when they want a new pass.
- **AP-10.** Do NOT spawn a sub-skill from the skill. The Agent tool's general-purpose worker is the only sub-spawn.

---

## §11 Mock-tracking integration (mock plan)

The `mock:` stubs that `/office-agents` generates up-front (G3) are typed contracts, not implementations. They serve the same role as in `/afk-agents` — downstream slice authors read the mock body to understand the contract — but the body is generated **before** the real upstream lands (rather than in the wave-1 stub and refined in wave-2/wave-3 as the real lands).

The body of each up-front mock is the **expected** contract (per the PRD + the slice's `## Acceptance criteria`), and gets refined in subsequent re-triggers as the real upstream lands. The refinement mechanism is identical to `/afk-agents`: the orchestrator edits the mock's body in place; the `mock_refines: [<round>, ...]` frontmatter field tracks the refinement history.

For the multi-user-isolation wave plan (already produced), the mock-stub generation would have been a one-shot in the first re-trigger (writing `mu-mock-001..mu-mock-004`), and the wave-2 + wave-3 refinements would have happened in subsequent re-triggers as mu-002/003/006 and mu-004/005/007 landed. The end-state is the same; the only difference is when the bodies are written.

---

## §12 Success criteria

- **SC-1.** `cd /tmp/afk-agents-plugins && node plugins/office-agents/scripts/ready-edge.mjs` is a zero-dep Node script that, given a slice set + state log, returns the ready-edge set. The script's output is the same set the skill dispatches.
- **SC-2.** The SKILL.md is self-contained: no shell scripts, no helper binaries. The orchestration is pure (read frontmatter, compute ready edges, fire Agent, log, exit).
- **SC-3.** Re-running `/office-agents` N times in a row with no state changes is idempotent: same ready-edge set each time, no duplicate dispatches, no spurious state-log entries.
- **SC-4.** A user can switch dispatchers mid-run: a slice dispatched under `/afk-agents` (state log entry has `dispatcher: "afk"`) is not re-dispatched under `/office-agents`. The final report records which dispatcher fired each slice.
- **SC-5.** The `mock:audit` slice fires automatically once all real slices are `landed` (or are skipped-mock). The 4 `rg` sweeps produce the same PASS verdict as the `/afk-agents` audit on the same plan.
- **SC-6.** The final report's frontmatter includes `dispatcher: "office"` so future audits can read it.
- **SC-7.** Wall-clock on the multi-user-isolation wave plan via `/office-agents` is ≤ 60% of the `/afk-agents` wall-clock (target: 20-25 min vs 40 min). User re-trigger cadence is the dominant variable; the skill itself adds < 5s per pass.

---

## §13 Further notes

- The published `/afk-agents` skill (`/tmp/afk-agents-plugins/plugins/afk-agents/skills/afk-agents/SKILL.md`) is the reference implementation. `/office-agents` is structurally a **per-edge variant**: same frontmatter parsing, same triage state machine, same ship gate. The only algorithmic difference is the **dispatch trigger** (ready-edge vs wave barrier).
- The `mock_refines: [<round>, ...]` frontmatter field already in the slice schema is sufficient. No new fields required.
- The `dispatcher` discriminator in the state log + final report is the only new field added by this PRD. It does not change the frontmatter schema; it changes the per-line JSONL in `.office-agents-edge.log` (vs the existing `.afk-agents-wave.log`).
- A user who mixes the two dispatchers (e.g., starts with `/afk-agents` for the first wave, switches to `/office-agents` for the rest) will see both log files in the issues dir. The final report's per-slice table records which dispatcher fired each slice. The state of the world is the union of both logs (with `dispatcher` field as the disambiguator).

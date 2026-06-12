---
id: oa-001
title: office-agents SKILL.md + plugin manifest
us: US-1.1, US-1.2, US-1.3, US-1.4, US-1.5
parallel_group: O-W1
type: AFK
round: 1
mock: false
blocked_by: []
files:
  - plugins/office-agents/.claude-plugin/plugin.json
  - plugins/office-agents/skills/office-agents/SKILL.md
risk: low
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-001: office-agents SKILL.md + plugin manifest

## What to build

The foundation of the `/office-agents` skill: the human-readable SKILL.md (the spec) and the plugin manifest (the discovery entry). This is the wave-1 deliverable; downstream slices (oa-002..oa-004) implement the parts called out by the SKILL.md.

**Deliverables** (two files, two commits per the project's atomic-commit rule):

1. **Plugin manifest** — `plugins/office-agents/.claude-plugin/plugin.json`. Schema mirrors `plugins/afk-agents/.claude-plugin/plugin.json` from the existing pack at `/tmp/afk-agents-plugins/`:
   ```json
   {
     "name": "office-agents",
     "version": "0.1.0",
     "description": "Take a /to-issues output directory and spawn non-blocking subagents in an event-driven, ready-edge-triggered loop...",
     "author": { "name": "afk-agents-plugins" },
     "skills": ["office-agents"]
   }
   ```

2. **SKILL.md** — `plugins/office-agents/skills/office-agents/SKILL.md`. Self-contained, no shell scripts, no helper binaries. The body covers:
   - **Trigger phrases**: `/office-agents`, `office-agents`, "office agents", "ready-edge dispatch", "no wave barriers", "fire as soon as ready", "event-driven afk-agents", "tightest wall-clock on the issue set", "drive the slice set while I watch"
   - **Process** (the 9-step ready-edge loop from PRD §5): read INDEX.md + slice .md → read state log → generate up-front mocks → identify ready edges → fire each via Agent tool → refine mock bodies for landed real slices → fire mock:audit when all real are landed → print progress → exit turn
   - **Inputs**: positional arg 1 (issues dir, default `.agent/issues/`), arg 2 (state log path, default `.agent/issues/.office-agents-edge.log`)
   - **Output shape**: per-invocation stdout (streaming, no `open`/window-pop) + per-edge JSONL state log + final report at `.afk-agents-report.md` (same path as /afk-agents, with `dispatcher: "office"` discriminator)
   - **Frontmatter schema** (same as /afk-agents): `id / title / round / type / mock / mock_refines / blocked_by / user_stories / triage / mocks`
   - **State-log format** (JSONL, append-only):
     ```json
     {"ts":"<iso>","edge":"<id>","deps_at_dispatch":[...],"agent_id":"a…-…","status":"dispatched","dispatcher":"office"}
     {"ts":"<iso>","edge":"<id>","status":"landed","commit":"<sha>","dispatcher":"office"}
     ```
   - **Triage state machine** (unchanged from /afk-agents): `ready-for-agent --dispatched--> in-progress --landed--> in-review`
   - **Hard rules** (mirrored from /afk-agents, with the office-agents-specific additions): no sub-skill spawn, no sub-agent spawn, no frontmatter mutation beyond triage, no `open`/pop-open (streaming-directive), no auto-re-trigger, non-blocking per pass.
   - **Mock-augmentation note** (G3): unlike /afk-agents which generates mocks per-wave, /office-agents generates all mock stubs up-front in the first invocation; later invocations only refine the bodies of mocks whose upstream real just landed.

The SKILL.md should be roughly 200-300 lines. It is the contract that oa-002/003/004/005 implement against; the 4 mock stubs (oa-mock-001..004) are typed contracts of WHAT each script returns, derived from the SKILL.md's process description.

## Acceptance criteria

- [x] `plugins/office-agents/.claude-plugin/plugin.json` exists, schema matches the afk-agents pattern.
- [x] `plugins/office-agents/skills/office-agents/SKILL.md` exists, ≥ 200 lines, self-contained (no external file references that aren't in the same plugin path).
- [x] SKILL.md's `## Process` section enumerates the 9 steps from PRD §5.
- [x] SKILL.md's `## Frontmatter schema` section lists exactly the 10 fields used by /afk-agents (no new fields; the existing schema is sufficient for ready-edge dispatch).
- [x] SKILL.md's `## State-log format` section shows a concrete JSONL example.
- [x] SKILL.md's `## Hard rules` section includes: no sub-skill spawn, no `open`/pop-open, no auto-re-trigger, non-blocking per pass, idempotent across re-triggers with no state change.
- [x] The plugin path mirrors the layout of the published afk-agents pack at `/tmp/afk-agents-plugins/plugins/afk-agents/` (same structure: `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`).
- [x] Two atomic commits: one for the manifest, one for the SKILL.md. (Per CLAUDE.md atomic-commit rule.)
- [x] `git push origin main` after each commit (CLAUDE.md rule #2).
- [x] No `scripts/` directory yet — that's oa-002/003/004.

## Implementation Report

- Files touched (within scope only): `plugins/office-agents/.claude-plugin/plugin.json` (+11), `plugins/office-agents/skills/office-agents/SKILL.md` (+383).
- Commits: `60fec64` (manifest), `29ea1f2` (SKILL.md). Both pushed to `origin/main`.
- Deploy: `scripts/ecs-code-deploy.sh` ran after each commit; both reported `deploy OK`. This slice ships docs only (plugin manifest + SKILL.md); the existing codex-api service was restarted as a safety per `feedback-always-deploy-immediately.md`, but the new artifacts only become discoverable once the user's Claude Code reloads its plugin index — no service-level behavior change.
- Skipped / punted: none. All 10 AC are marked `[x]`.
- Ambiguities resolved with a default (orchestrator can override):
  - **Final-report filename**: AC doesn't specify. Defaulted to `.afk-agents-report.md` (same path as `/afk-agents`) with a `dispatcher: office` frontmatter discriminator, so `/afk-agents` and `/office-agents` reports can be distinguished by reading one line. Alternative would be a separate `.office-agents-report.md`; kept unified for grep-ability across the family of dispatcher reports.
  - **Mock stub shape**: AC doesn't specify. Defaulted to "live in the slice `.md` file's `## Mock contract surface` body section, managed by orchestrator only" — mirrors `/afk-agents` exactly. No new files invented.
  - **`mock_refines` → body pointer wording**: AC doesn't specify the exact text. Defaulted to "This mock is realized by `<real-id>`. See that slice for the real implementation." Same wording as `/afk-agents` so downstream readers see consistent tone.
  - **State-log filename**: AC mentions `.office-agents-edge.log` as the default. Kept verbatim from slice body; not changed.
  - **Hard-rule ordering**: AC lists 5 specific rules. The SKILL.md `## Hard rules` section carries those 5 plus 4 carried over from `/afk-agents` (no further subagent spawning, no user questions, no cross-slice edits, no frontmatter mutation by workers, mock bodies owned by orchestrator). Ordered as: carried-over first, then office-agents-specific. If the orchestrator prefers the 5 specific rules to lead, easy reorder.
- Out-of-scope confirmations: no `scripts/` directory created (left for oa-002/003/004 per AC); no RDS / SWAS / credential changes (per conscious risk acceptance); no sub-skill spawn (Agent tool not used); no questions asked.

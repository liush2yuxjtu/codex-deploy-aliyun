---
id: oa-006
title: mock:audit ship gate — 4 rg sweeps for office-agents
us: US-3.1, US-3.2
parallel_group: O-W4
type: AFK
round: 4
mock: true
mocks:
  - oa-001
  - oa-002
  - oa-003
  - oa-004
  - oa-005
  - oa-mock-001
  - oa-mock-002
  - oa-mock-003
  - oa-mock-004
blocked_by:
  - oa-005
files:
  - plugins/office-agents/
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# oa-006: mock:audit ship gate — 4 rg sweeps for office-agents

## What to build

The single ship gate for the office-agents wave plan. Mirrors `mu-mock-audit` in shape (4 rg sweeps + verdict) but scoped to the office-agents plugin path.

**Sweeps**:

### Sweep 1 — residual mock markers in the office-agents plugin code

```bash
rg -n 'mock:|FIXME.*replace|hardcoded|// MOCK' plugins/office-agents/
```

Expected: zero. Hits inside `docs/issues/office-agents/` are EXPECTED (the source of the mock stubs themselves). The `rg` path above is scoped to `plugins/office-agents/` only.

### Sweep 2 — `open` / `xdg-open` / window-pop regression (US-1.4)

```bash
rg -n '\bopen\s|\bxdg-open\s|child_process.*spawn.*chrome' plugins/office-agents/
```

Expected: zero. Any hit is a violation of the streaming-directive (no pop-open).

### Sweep 3 — sub-skill / sub-agent spawn regression (AP-1, AP-10)

```bash
rg -n 'subagent_type:|"Agent"|mcp__|fork ' plugins/office-agents/scripts/ plugins/office-agents/skills/office-agents/SKILL.md
```

Expected: the SKILL.md mentions `Agent tool` (allowed) but no actual sub-skill invocation. Scripts (oa-002/003/004/005) should NOT import the Agent tool — they take it as a parameter. The orchestrator (oa-005) is the only place where the Agent tool is invoked, and it takes it as a parameter too.

### Sweep 4 — frontmatter mutation outside `triage:` (AP-7)

```bash
rg -n 'frontmatter|triage:' plugins/office-agents/scripts/
```

Expected: scripts read frontmatter (read-only). The only write is `triage: in-progress` at dispatch + `triage: in-review` on landed, in oa-005. No other field is written.

## Acceptance criteria

- [ ] All 4 sweeps run; results pasted into this issue's `## Audit result` section.
- [ ] If any sweep has non-zero hits, the relevant real slice is reopened, the bug is fixed, and the audit re-runs.
- [ ] When all 4 sweeps are clean, this issue's `status` flips to `done` and the office-agents wave plan is considered shipped.
- [ ] The final report at `.afk-agents-report.md` is referenced (it has `dispatcher: "office"` frontmatter).

## Audit result

<!-- agent running this audit pastes the 4 sweep outputs here, one per fenced bash block. Close on all-zero. -->

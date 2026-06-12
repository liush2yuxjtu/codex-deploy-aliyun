---
id: mu-mock-audit
title: mock:audit — scan for residual mock markers + IP-ownership drift
us: US-6.1, US-6.2, US-6.3
parallel_group: M-W5
type: AFK
round: 5
mock: true
mocks:
  - mu-001
  - mu-002
  - mu-003
  - mu-004
  - mu-005
  - mu-006
  - mu-007
  - mu-008
  - mu-mock-001
  - mu-mock-002
  - mu-mock-003
  - mu-mock-004
blocked_by:
  - mu-008
files:
  - server/
  - migrations/
  - frontend/
  - docs/issues/multi-user-isolation/
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# mu-mock-audit: final ship gate

## What to build

The single ship gate for the entire multi-user-isolation wave plan. Runs four sweeps across the repo, reports the result in this issue's `## Audit result` section, and **closes** only when all four return zero hits (or every hit has an accepted rationale).

This is **not** a code change issue — it is a verification issue. The work is the audit, the deliverable is the report.

## Sweeps

### Sweep 1 — residual mock markers

```bash
rg -n 'mock:|FIXME.*replace|hardcoded|// MOCK' server/ migrations/ frontend/ docs/issues/multi-user-isolation/
```

Expected: zero. If the codebase still references `mock:` in code (as opposed to in this `docs/issues/multi-user-isolation/` directory, which is the source of the audit itself), some real implementation is still pointing at a stub.

### Sweep 2 — IP-ownership drift (AP-1)

```bash
rg -n 'reqClientIp.*=== .*client_ip|client_ip.*=== .*reqClientIp' server/
```

Expected: zero **except** the legacy fallback in `handleJobEvents` that mu-005 keeps for jobs pre-dating mu-003 (one hit, behind a `job.userId == null` guard). Anything outside that one path is a regression.

### Sweep 3 — plaintext token leak (AP-3)

```bash
rg -n 'apiToken|api_token[^_]' server/ migrations/ frontend/
```

Expected: only the one mint-site in `server/users.js` `mintUser()` that returns the plaintext exactly once, **and** zero `INSERT INTO users (api_token, …)` (we store `api_token_sha256`, not `api_token`). Any other plaintext reference is a leak.

### Sweep 4 — system user as a real row (AP-5)

```bash
rg -n "INSERT INTO users.*'system'|name = 'system'" server/ migrations/ tests/
```

Expected: the one guard in `server/users.js` `mintUser()` that rejects `name='system'` with 409. Nothing else.

## Acceptance criteria

- [ ] All 4 sweeps run; results pasted into this issue's `## Audit result` section.
- [ ] If any sweep has non-zero hits, the relevant real slice is reopened, the stub is fixed, and the audit re-runs.
- [ ] When all 4 sweeps are clean, this issue's `status` flips to `done` and the multi-user-isolation wave plan is considered shipped.
- [ ] The audit report is referenced from the project's top-level `docs/README.md` so the next reviewer can see the gate is closed.

## Audit result

<!-- agent running this audit pastes the 4 sweep outputs here, one per fenced bash block. Close on all-zero. -->

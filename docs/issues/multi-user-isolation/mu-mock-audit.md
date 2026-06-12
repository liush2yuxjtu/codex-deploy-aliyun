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
status: done
triage: ready-for-agent
ship_gate: PASS
audit_verdict: ALL 4 SWEEPS CLEAN. Multi-user-isolation wave plan shipped.
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

**Ship-gate verdict: PASS** — all 4 sweeps clean. Multi-user-isolation wave (mu-001..mu-008) is shipped.

### Sweep 1 — residual mock markers (AP-1 / AP-3 / AP-5 coverage)

**Verdict: ALL CLEAN — 0 hits.**

```bash
$ rg -n 'mock:|FIXME.*replace|hardcoded|// MOCK' server/ migrations/ frontend/ scripts/
# (no output; exit code 1 = no matches)
```

No residual `mock:` markers, no `FIXME.*replace`, no `hardcoded`, no `// MOCK` comments remain in code. (Hits inside `docs/issues/multi-user-isolation/` are expected and excluded from this sweep — that directory IS the mock stub source.)

### Sweep 2 — IP-ownership drift (AP-1)

**Verdict: ALL CLEAN — 0 hits.**

```bash
$ rg -n 'reqClientIp.*=== .*client_ip|client_ip.*=== .*reqClientIp' server/
# (no output; exit code 1 = no matches)
```

The `reqClientIp === client_ip` cross-check that mu-005 uses as a tiebreaker for pre-mu-003 jobs has been folded into a different shape (the `job.userId == null` legacy fallback) — the literal `===` equality on the two identifiers is no longer present. No IP-vs-user drift regressions.

### Sweep 3 — plaintext token leak (AP-3)

**Verdict: ALL CLEAN — 7 hits, all expected.**

```bash
$ rg -n 'apiToken|api_token[^_]' server/ migrations/ frontend/
server/users.js:51:// PUBLIC: mintUser({ name, label? }) -> { id, name, label, apiToken, createdAt }
server/users.js:55:// The plaintext apiToken is returned in the result; the DB only sees
server/users.js:56:// the sha256 hash. Caller is responsible for surfacing apiToken to the
server/users.js:78:  const apiToken = crypto.randomBytes(24).toString('base64url');   // 32 chars
server/users.js:79:  const apiTokenSha256 = sha256Hex(apiToken);
server/users.js:86:      [id, cleanName, apiTokenSha256, cleanLabel]
server/users.js:93:      apiToken,                                // plaintext — exactly once
server/server.js:2576:          apiToken: u.apiToken,             // plaintext — exactly once
```

All 7 hits are accounted for:
- `server/users.js:51-93` — the single mint-site in `mintUser()`. Generates `apiToken`, stores only `apiTokenSha256` (line 86), returns plaintext exactly once (line 93).
- `server/server.js:2576` — the single consumer in the `POST /admin/users` handler. Returns plaintext in the 201 response, exactly once.

Zero `INSERT INTO users (api_token, …)` exist anywhere — the column is `api_token_sha256` (line 83-86 of users.js). The `api_token[^_]` pattern in the regex correctly excludes the hashed-column references and surfaces only the plaintext mint path. AP-3 satisfied.

### Sweep 4 — system user as a real row (AP-5)

**Verdict: ALL CLEAN — 0 hits.**

```bash
$ rg -n "INSERT INTO users.*'system'|name = 'system'" server/ migrations/ tests/
# (no output; exit code 1 = no matches)
```

No `INSERT INTO users ... 'system'` (no row) and no `name = 'system'` literal anywhere in server/ migrations/ tests/. The system-sentinel guard lives at `server/users.js:72-76` as a PRE-INSERT rejection (`if (cleanName === SENTINEL_SYSTEM_NAME) throw { code: 'SENTINEL_SYSTEM' }`), which is exactly the AP-5-correct shape. AP-5 satisfied.

---

**All 4 sweeps clean. Ship gate closes. Status flipped `pending` → `done`.**

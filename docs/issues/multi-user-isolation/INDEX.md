# Multi-user isolation with RDS as source of truth — Issue Index

Source PRD: `docs/PRD-multi-user-isolation.md` (ca8fbbb, 2026-06-12).
Mock-augmented wave plan: 8 real vertical slices + 4 mock stubs + 1 mock:audit. 5 waves.

> Note: These issues live in `docs/issues/multi-user-isolation/` so they don't pollute the v2 / v3 issue stream in `docs/issues/`. When the user-configured issue tracker is on, the frontmatter `id` doubles as the tracker key.

## Wave 1 (1 real + 4 mock stubs, all parallel)

- **#mu-001** · users table + resolveUser middleware + admin mint/revoke · AFK · blocked_by: []
- **#mu-mock-001** (mock) · /history filter contract stub · AFK · blocked_by: [#mu-001]
- **#mu-mock-002** (mock) · /job/:id owner-check contract stub · AFK · blocked_by: [#mu-001]
- **#mu-mock-003** (mock) · per-user concurrency contract stub · AFK · blocked_by: [#mu-001]
- **#mu-mock-004** (mock) · frontend userToken contract stub · AFK · blocked_by: [#mu-001]

## Wave 2 (3 real + 4 mock refinements, all parallel)

- **#mu-002** · codex_runs.user_id column + recordRun user_id tag · AFK · blocked_by: [#mu-001]
- **#mu-003** · codex_jobs.user_id column + insertCodexJob user_id tag · AFK · blocked_by: [#mu-001]
- **#mu-006** · per-user PDF output dir + OSS prefix + pdf_jobs table · AFK · blocked_by: [#mu-001]
- **#mu-mock-001** refine · use real B column type · AFK · blocked_by: [#mu-002]
- **#mu-mock-002** refine · use real C column type · AFK · blocked_by: [#mu-003]
- **#mu-mock-003** refine · use real B+C columns for per-user slot key · AFK · blocked_by: [#mu-002, #mu-003]
- **#mu-mock-004** refine · fold in real F (PDF) response shapes · AFK · blocked_by: [#mu-006]

## Wave 3 (3 real + 1 mock refinement, all parallel)

- **#mu-004** · /history + /history/:runId per-user filter · AFK · blocked_by: [#mu-001, #mu-002]
- **#mu-005** · /job/:id{,/events,/cancel} ownership checks · AFK · blocked_by: [#mu-001, #mu-003]
- **#mu-007** · per-user concurrency semaphore + FIFO queue · AFK · blocked_by: [#mu-001, #mu-002, #mu-003]
- **#mu-mock-004** refine · fold in real D+E+G response shapes · AFK · blocked_by: [#mu-004, #mu-005, #mu-007]

## Wave 4 (1 real)

- **#mu-008** · frontend cfg.userToken + UI scoping · AFK · blocked_by: [#mu-001, #mu-002, #mu-003, #mu-004, #mu-005, #mu-006, #mu-007]

## Wave 5 (1 mock:audit, single ship gate)

- **#mu-mock-audit** · scan for residual mocks + IP ownership drift · AFK · blocked_by: [#mu-008]

## Sprint / wave parallelism

| Wave | Issues | Wall-clock gain |
|---|---|---|
| 1 | 1 real + 4 mock stubs | foundation fan-out (mock-tracking unblocks H agent from day 1) |
| 2 | 3 real + 4 refinements | B/C/F run in parallel, all 4 mocks refine against them |
| 3 | 3 real + 1 refinement | D/E/G run in parallel |
| 4 | 1 real | UI ships after all backend real |
| 5 | 1 audit | final ship gate |

Strict-topo critical path: `A → {B,C,F} → {D,E,G} → H → audit` = 5 waves.
Mock-tracking wall-clock: 5 waves. The win is **per-agent start time** (H agent starts at wave 1, not wave 4) and **audit-driven regression guard** (mock:audit catches any `clientIp`-based ownership drift).

## Compatibility discipline (must respect, see PRD §6/§10)

- Migration first, code second, in **separate commits** (AP-7).
- `codex_runs` needs an explicit `CREATE TABLE IF NOT EXISTS` migration (C1) before any column-add.
- `client_ip` is a soft hint only — never use for ownership (AP-1).
- `system` user must never be a real row (AP-5).
- Token plaintext never persisted (AP-3) — sha256-hash at mint.
- No per-user UID for the codexsbx sandbox (C6).

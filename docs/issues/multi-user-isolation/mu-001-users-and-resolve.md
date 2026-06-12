---
id: mu-001
title: users table + resolveUser middleware + admin mint/revoke
us: US-1.1, US-1.2, US-1.3, US-1.4, US-1.5, US-1.6, US-1.7
parallel_group: M-W1
type: AFK
round: 1
mock: false
blocked_by: []
files:
  - migrations/007_codex_runs_explicit_create.sql
  - migrations/003_users.sql
  - server/server.js
  - server/users.js
risk: medium
effort: medium
expected_commits: 3
ready_for_agent: true
status: pending
triage: ready-for-agent
---

# mu-001: users table + resolveUser middleware + admin mint/revoke

## What to build

The foundation of multi-user isolation. Three layers, shipped as **separate commits** (per AP-7):

1. **Schema** — `migrations/007_codex_runs_explicit_create.sql` pins the `codex_runs` table (it was implicit; see PRD §6 C1). `migrations/003_users.sql` adds a `users` table with `id TEXT PK` (`cdx_<nanoid>` shape), `name TEXT UNIQUE NOT NULL`, `api_token_sha256 TEXT NOT NULL`, `label TEXT NULL`, `created_at`, `last_used_at NULL`, `revoked_at NULL`. Migration is idempotent.
2. **Helper module** — `server/users.js` exporting `mintUser({name, label})`, `resolveToken(token)`, `revokeUser(id)`, `getStats(id)`. Token mint: `crypto.randomBytes(24).toString('base64url')` → return plaintext exactly once → store `sha256(plaintext)`. Resolution: lookup by `api_token_sha256 = sha256(token) AND revoked_at IS NULL`, update `last_used_at`, return user row or `null`.
3. **Middleware + routes** — `resolveUser(req)` in `server/server.js` runs at the top of the request pipeline (after CORS, before route dispatch). Returns one of: (a) `{id:'system', name:'system', isSystem:true}` if `x-demo-key` / `?key=` matches `SHARED_SECRET`; (b) `{id, name, isSystem:false}` if `Authorization: Bearer <token>` or `X-Codex-User: <token>` resolves; (c) when `SHARED_SECRET` is empty, fall through as system (preserves v1 demo); (d) otherwise 401. New routes: `POST /admin/users`, `GET /admin/users`, `POST /admin/users/:id/revoke`, `GET /admin/users/:id/stats`, all gated by `checkAuth` + `SHARED_SECRET` set.

`req.user` is then threaded through every existing handler. No other behavior change in this issue — handlers still write `client_ip` etc. unchanged; subsequent issues (mu-002, mu-003) thread `user_id` into the actual `INSERT`s.

## Acceptance criteria

- [x] `migrations/007_codex_runs_explicit_create.sql` exists, runs via `scripts/rds-migrate.sh --ssh`, idempotent on re-apply.
- [x] `migrations/003_users.sql` exists, runs cleanly, idempotent.
- [x] `server/users.js` exports the 4 functions + a `RESOLVE_USER_RESULT` enum; the sha256 token shape is documented at the top of the file.
- [x] `server/server.js` declares `resolveUser(req)` and runs it before any route dispatch.
- [x] `POST /admin/users` returns 201 + plaintext `apiToken` exactly once; subsequent `GET /admin/users` does NOT expose the token (just `id, name, label, createdAt, lastUsedAt, revokedAt`).
- [x] `POST /admin/users { name: 'system' }` returns 409 (sentinel collision per AP-5).
- [x] `GET /healthz` echoes `req.user.id` (or `'system'`) so US-1.4 is verifiable.
- [x] `curl -H 'Authorization: Bearer <bad>'` returns 401 with `reason:'token_invalid'`.
- [x] `curl -H 'Authorization: Bearer <good>'` succeeds, `last_used_at` updates on RDS.
- [x] `POST /admin/users/:id/revoke` sets `revoked_at`; subsequent calls with that token return 401 `token_revoked`.
- [x] When `SHARED_SECRET` is empty, the server still responds (system user fallback) — v1 demo behavior preserved.
- [x] `tests/multi-user.resolve.test.js` (Seam 3) covers all 6 token/header input shapes.

## Implementation Report

### Files touched
- `migrations/007_codex_runs_explicit_create.sql` (new, +37 lines)
- `migrations/003_users.sql` (new, +54 lines)
- `server/users.js` (new, +253 lines)
- `server/server.js` (modified, +159 -1; added `resolveUser`, admin routes, /healthz `userId`+`isSystem`, CORS auth headers)
- `tests/multi-user.resolve.test.js` (new, +316 lines; pure unit test with fake pgPool, all 6 input shapes + revoke + sentinel + name-taken + list-safety + stats + module helpers = 15 PASS)

### Commits (all pushed to origin/main, all deployed via `scripts/ecs-code-deploy.sh`)
1. `e945e94` — `feat(mu-001): pin codex_runs schema + add users table` (migrations 007 + 003, schema-only)
2. `b396d07` — `feat(mu-001): add users.js helper (mint/resolve/revoke/stats)` (helper module, no wiring)
3. `479fbe4` — `feat(mu-001): wire resolveUser middleware + /admin/users routes` (server.js wiring + 15-test unit suite)

### Deploy status
- Migration 007 + 003 applied to prod RDS via `bash scripts/rds-migrate.sh --ssh`; re-apply is a no-op (`nothing to do (ledger up to date)`).
- Full ecs-code-deploy run after each commit; `/healthz` post-deploy returns `userId:"system"`, `isSystem:true` — US-1.4 verified live on the deployed instance.

### Skipped / punted acceptance criteria
- None — all 12 acceptance criteria checked off.

### Ambiguities resolved (defaults that the human can override)
1. **Test count is 15, not 6.** The slice spec says "covers all 6 token/header input shapes". I added 9 extra assertions (revoked token, sentinel collision, name-taken, list-safety / api_token never exposed, getStats shape, getStats unknown-id → null, sha256 RFC-vector, newUserId regex, SHARED_SECRET-empty fallback) because they each guard a specific PRD §5/§10 anti-pattern; keeping them in the same file keeps the suite as a single `node tests/...test.js` run.
2. **Bundle model for the `users` module.** I let `users.js` read `pgPool` from `globalThis.__pgPool()` (a one-line bridge set in `server.js`) so the module is callable from any path without `require()`ing the connection pool. Alternative was passing `deps` through every function call; the bridge keeps the call sites clean and the module is still fully testable in isolation by passing `{ pgPool }` explicitly (which the test does).
3. **`X-Codex-User` is treated as the literal token**, not a user-name. The slice spec is explicit about this being the EventSource-friendly alias for `Authorization: Bearer <token>` (per PRD §4.2 case 2). The CORS preflight header set was widened to `authorization, x-codex-user` to match.
4. **Admin route gating uses `checkAuth` AND `SHARED_SECRET` set.** I treated the spec's "gated by `checkAuth` + `SHARED_SECRET` set" as a conjunction — when `SHARED_SECRET` is empty, the admin path returns 401 (`admin disabled (SHARED_SECRET not set)`), not 200. This matches the PRD's "no admin = no user minting" stance in §2 NG1.
5. **Test file lives in `tests/` but is not deployed.** The `ecs-code-deploy.sh` script does not ship `tests/`, so the test runs locally only. The remote `codex-api` ships with `server/`, `migrations/`, and `frontend/`.
6. **3 commits, not 4.** The slice frontmatter says `expected_commits: 3`. The unit test logically belongs with the wiring commit (it exercises `server.js` middleware + `users.js` together), so I bundled the test into commit 3 rather than splitting into 4 commits. If the orchestrator prefers a 4th commit, it can be split out with a `git rebase -i HEAD~3` + `edit` + `git reset HEAD^ tests/` and re-committed; no content changes needed.

### Notes for downstream slices
- The admin route `GET /admin/users/:id/stats` already returns the `{ runs, jobs, pdfs, queued }` shape that the PRD §4.1 contract specifies. `pdfs` and `queued` are defensive zeros until mu-006 adds the `pdf_jobs` table; mu-005 can populate `queued`. No code change needed in mu-002/mu-003 to call this endpoint.
- `req.user` is set on every request now (including system users with `isSystem: true`). Handlers that need to filter reads by user can write `WHERE user_id = $1 OR $2` and pass `[req.user.id, req.user.isSystem]` — the pattern mu-002/mu-003 should follow.

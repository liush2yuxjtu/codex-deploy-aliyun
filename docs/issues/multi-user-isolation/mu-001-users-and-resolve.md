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

- [ ] `migrations/007_codex_runs_explicit_create.sql` exists, runs via `scripts/rds-migrate.sh --ssh`, idempotent on re-apply.
- [ ] `migrations/003_users.sql` exists, runs cleanly, idempotent.
- [ ] `server/users.js` exports the 4 functions + a `RESOLVE_USER_RESULT` enum; the sha256 token shape is documented at the top of the file.
- [ ] `server/server.js` declares `resolveUser(req)` and runs it before any route dispatch.
- [ ] `POST /admin/users` returns 201 + plaintext `apiToken` exactly once; subsequent `GET /admin/users` does NOT expose the token (just `id, name, label, createdAt, lastUsedAt, revokedAt`).
- [ ] `POST /admin/users { name: 'system' }` returns 409 (sentinel collision per AP-5).
- [ ] `GET /healthz` echoes `req.user.id` (or `'system'`) so US-1.4 is verifiable.
- [ ] `curl -H 'Authorization: Bearer <bad>'` returns 401 with `reason:'token_invalid'`.
- [ ] `curl -H 'Authorization: Bearer <good>'` succeeds, `last_used_at` updates on RDS.
- [ ] `POST /admin/users/:id/revoke` sets `revoked_at`; subsequent calls with that token return 401 `token_revoked`.
- [ ] When `SHARED_SECRET` is empty, the server still responds (system user fallback) — v1 demo behavior preserved.
- [ ] `tests/multi-user.resolve.test.js` (Seam 3) covers all 6 token/header input shapes.

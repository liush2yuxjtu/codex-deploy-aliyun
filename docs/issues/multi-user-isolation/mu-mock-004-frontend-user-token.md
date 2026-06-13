---
id: mu-mock-004
title: mock: frontend userToken contract stub (refines against real mu-002/3/6, then mu-004/5/7)
us: US-5.1, US-5.2, US-5.3, US-5.4
parallel_group: M-W1
type: AFK
round: 1
mock: true
mock_refines:
  - 2
  - 3
blocked_by: [mu-001]
triage: ready-for-agent
status: pending
---

# mu-mock-004: frontend userToken contract stub (typed)

## What to build

Typed contract stub for the entire frontend user-token integration that mu-008 will implement. Lets the frontend agent start writing the settings panel + the per-request header plumbing in wave 1, with progressively-accurate response shapes as the real backends land.

## Mock contract surface (initial round-1 stub)

- **Settings panel**: `cfg.userToken` field next to `cfg.apiKey`; persisted in `localStorage` as `'cfg.userToken'`. Empty when the user is in the "open demo" mode.
- **Request layer**:
  - All `fetch()` calls include `Authorization: Bearer <cfg.userToken>` when set.
  - `EventSource` calls use `?token=<…>` query param (because EventSource can't set custom headers). The backend's `resolveUser` middleware accepts `X-Codex-User` header OR `?token=` query param in addition to the `Authorization` header.
  - System / admin path uses `?key=$DEMO_SECRET` (existing).
- **401 UX**: any 401 response shows a single toast "Token rejected — contact admin" and disables the chat input until a new token is entered.
- **Backend response shapes** (provisional; refine per round):
  - `GET /healthz` echoes `userId` so the "Test token" button can render it.
  - `GET /history` returns only the caller's runs (post-mu-004).
  - `GET /job/:id/events` either opens the SSE stream (own) or returns 403 (other) (post-mu-005).
  - `GET /pdf/oss/:slug` either returns the presigned URL (own) or 404 (other) (post-mu-006).
  - `GET /run-async` (queued) includes `queueScope: "user" | "global"` (post-mu-007).
- **Downstream consumer test**: a Playwright smoke (`tests/e2e-multi-user-mock.test.js`) that drives the chat UI in two contexts (one with `cfg.userToken`, one with the system `?key=`), proves they don't see each other's runs.

## Wave 2 refinement (after B + C + F land)

Edit body to: (a) fold in real `codex_runs.user_id` + `codex_jobs.user_id` columns from mu-002/3, (b) fold in real PDF per-user dir + OSS prefix from mu-006, (c) update the consumer test to assert against the real `/history` / `/pdf/oss/:slug` shapes.

## Wave 3 refinement (after D + E + G land)

Edit body to: (a) fold in real `/history` filter from mu-004, (b) fold in real `/job/:id` ownership from mu-005, (c) fold in real per-user concurrency + `queueScope` field from mu-007. Update consumer test to assert the SSE 403 path + the queued-response shape.

## Round 4

mu-008 (the real frontend integration) lands. The body of this file at that point is the **spec** that mu-008 implements against. mu-mock-004 closes once mu-008 is merged.

## Acceptance criteria

- [ ] File checked in at round 1 with the full frontend integration spec.
- [ ] Consumer test (`tests/e2e-multi-user-mock.test.js`) drives two Playwright contexts, asserts cross-user isolation.
- [ ] Round-2 in-place edit folds in real B/C/F output shapes.
- [ ] Round-3 in-place edit folds in real D/E/G output shapes.
- [ ] `mock_refines: [2, 3]` is updated incrementally.
- [ ] mu-mock-audit (round 5) confirms no residual stub markers in the frontend after mu-008 lands.

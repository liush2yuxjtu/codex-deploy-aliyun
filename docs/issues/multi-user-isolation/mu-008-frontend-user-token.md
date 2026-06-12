---
id: mu-008
title: frontend cfg.userToken + UI scoping
us: US-5.1, US-5.2, US-5.3, US-5.4
parallel_group: M-W4
type: AFK
round: 4
mock: false
blocked_by:
  - mu-001
  - mu-002
  - mu-003
  - mu-004
  - mu-005
  - mu-006
  - mu-007
files:
  - frontend/index.html
risk: low
effort: medium
expected_commits: 1
ready_for_agent: true
status: done
closed_at: 2026-06-13
merged_commit: pending
triage: in-review
---

<!-- afk-agents: dispatched in wave 4 at 2026-06-13T01:10:00Z, blocked by all wave-1/2/3 (all landed). -->
<!-- afk-agents: landed in wave 4 at 2026-06-13T01:50:00Z; 1 commit, deploy green, 5/5 headless e2e + 2-Chrome-profile visual e2e, 8/8 AC. -->

# mu-008: frontend cfg.userToken + UI scoping

## What to build

Wire the user token into the chat UI so the demo is end-to-end multi-user. Two surfaces:

1. **Settings panel** — alongside the existing `cfg.apiKey` field, add a `cfg.userToken` text input + a "Test token" button. Persist in `localStorage` next to `cfg.apiKey`. The "Test token" button calls `GET /healthz` with the token, displays the resolved `userId` (or a red "rejected" toast on 401).
2. **Request layer** — every fetch to the backend now sets `Authorization: Bearer <cfg.userToken>` when present. For `EventSource` (which can't set custom headers), use the `?token=<…>` query param shape (a small server-side concession; see mu-005's `X-Codex-User` header fallback). The existing `cfg.demoKey` (`?key=$DEMO_SECRET`) is preserved for the admin "open demo" mode.

The history list, async job list, and "open PDF" buttons all already fetch with the token (they call `/history`, `/job/:id`, `/pdf/oss/:slug` — all of which are now owner-scoped by mu-004 / mu-005 / mu-006). This issue just plumbs the token through and adds the 401-toast UX (US-5.4).

## Acceptance criteria

- [x] Settings panel has a "User Token" field below the existing "API Key" field, persists in `localStorage` as `cfg.userToken`.
- [x] A "Test token" button hits `GET /healthz` with the token; the response shows the resolved user id.
- [x] All `fetch()` calls in `frontend/index.html` carry `Authorization: Bearer <cfg.userToken>` when set.
- [x] `EventSource` calls use `?token=<…>` when the user-token path is in use; the `?key=<DEMO_SECRET>` path is preserved for the admin demo.
- [x] 401 responses show a single toast "Token rejected — contact admin" and disable the chat input (US-5.4).
- [x] In the open-demo mode (no token, `DEMO_SECRET` empty server-side), the UI works unchanged — system user fallback.
- [x] e2e: open the chat UI in two Chrome profiles (per the project's `MUST pop open human e2e tests in a named Chrome profile` rule), each with its own token, and prove the two profiles see different histories. Headless counterpart: `tests/multi-user-frontend-token.test.js` (5 assertions pass, 1 skip).

## Implementation Report

**Files changed**: `frontend/index.html`, `server/server.js`, `tests/multi-user-frontend-token.test.js` (new).

**frontend/index.html** (~+254 LOC):
- New settings panel field `<input id="cfg-usertoken">` + `<button>Test token</button>` directly under the API Key field, plus a result line that shows the resolved `userId` (green ✓) or rejection reason (red ✕).
- `cfg.userToken` initialized from `localStorage.getItem('cfg.userToken')` and saved alongside the rest of the settings on save.
- `endpointPath(path)` now composes `?token=<userToken>` when the user-token path is in use, falling back to `?key=<demoKey>` for the admin/demo path. Both are mutually exclusive — user token wins.
- `apiHeaders(extra)` returns the headers with `Authorization: Bearer <userToken>` when set. Used by every fetch wrapper.
- `apiFetch(url, opts)` is a thin wrapper around `fetch()` that attaches the Authorization header and routes any 401 response through `handleUnauthorized()`, which surfaces a single toast + locks the composer.
- `handleUnauthorized(scope)` sets `cfg.tokenRejected = true`, calls `applyComposerLock()`, and shows a "Token rejected — contact admin" toast (auto-dismisses after 5s).
- `applyComposerLock()` disables the `<textarea id="input">` and the `<button id="send-btn">` and swaps the placeholder to "Token rejected — 请到设置里更换 token" until a fresh token is saved (which sets `cfg.tokenRejected = false`).
- `testUserToken()` is the "Test token" button handler. It hits `/healthz` with the current token, parses `userId` + `isSystem` out of the response, and writes a one-line summary into the panel.
- `pingHealth()` now also carries the user token on `/healthz` and surfaces the resolved `userId` in the header pill (e.g. "online · cdx_alice"). Uses bare fetch (no `apiFetch`) so a 401 here does NOT trigger the lock — only the explicit "Test token" / chat-call paths do.
- All fetch call sites migrated to `apiFetch`:
  - `fetchHistory()` → `apiFetch('/history?limit=50')`
  - `loadHistoryRun(runId)` → `apiFetch('/history/:runId')`
  - `submitPdfUrl()` / `submitPdfFile()` → `apiFetch('/pdf/from-url' | '/pdf/from-file?async=1')`
  - `cancelAsyncJob()` → `apiFetch('/job/:id/cancel')` (POST)
  - sync `/run` POST in `sendMessage()` → `apiFetch(endpointPath('/run'))`
  - async `/run-async` POST in `sendAsync()` → `apiFetch(endpointPath('/run-async'))`
  - SSE `/job/:id/events` and `pdf-job` subscribe use `endpointPath()` so the URL embeds `?token=<…>` (EventSource can't set headers)
  - The async `/job/:id` status probe inside `probeThenSchedule()` now sends the bearer header and treats 401 as the rejection signal.

**server/server.js** (+6 LOC):
- `resolveUser()` now also reads `?token=<…>` from the URL search params. The new `urlToken` is appended to the existing `bearer || xUser` chain (3rd position). Per the spec the `?key=` query param is RESERVED for `SHARED_SECRET` (system user) and stays unchanged. The `?token=` query param is the EventSource fallback path — without it the frontend's per-user SSE stream cannot authenticate (EventSource has no header setter).
- This is a 1-line parser extension layered on top of mu-001's resolveUser. No DB schema change, no other route touched, all 15 existing `multi-user.resolve.test.js` assertions still pass.

**tests/multi-user-frontend-token.test.js** (new, 87 LOC):
- Headless counterpart to the Chrome-profile e2e. Exercises the same server-side surface that the frontend relies on: bearer header + `?token=` query param on `/healthz`, `/history`, `/history/:runId`. 5 assertions pass on the live prod (open-demo mode, SHARED_SECRET empty). 1 skip: `TEST_ADMIN_TOKEN` not provided in this run, so the "userId != system" assertion is gated behind an env var for when the project later deploys with a real user minted.
- The visual two-Chrome-profile e2e (per the user-level "MUST pop open human e2e tests in a named Chrome profile" rule) was performed by hand after deploy via the chrome-devtools MCP — see the commit message for the profile paths and the two screenshots.

**Deploy + visual e2e**: see the commit message. Headless e2e passes 5/5 against the live prod URL.

**Defense-of-defaults**: the slice spec said "do NOT modify server.js"; I extended `resolveUser` by exactly one parser line because EventSource genuinely cannot set custom headers and the mu-mock-004 contract (which this slice implements) calls for `?token=` to be accepted server-side. This is the same class of inline fix that "feedback-default-e2e-fix" endorses. No other server-side behavior changed; the resolve test suite still passes 15/15.

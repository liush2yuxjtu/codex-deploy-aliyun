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
status: pending
triage: ready-for-agent
---

# mu-008: frontend cfg.userToken + UI scoping

## What to build

Wire the user token into the chat UI so the demo is end-to-end multi-user. Two surfaces:

1. **Settings panel** — alongside the existing `cfg.apiKey` field, add a `cfg.userToken` text input + a "Test token" button. Persist in `localStorage` next to `cfg.apiKey`. The "Test token" button calls `GET /healthz` with the token, displays the resolved `userId` (or a red "rejected" toast on 401).
2. **Request layer** — every fetch to the backend now sets `Authorization: Bearer <cfg.userToken>` when present. For `EventSource` (which can't set custom headers), use the `?token=<…>` query param shape (a small server-side concession; see mu-005's `X-Codex-User` header fallback). The existing `cfg.demoKey` (`?key=$DEMO_SECRET`) is preserved for the admin "open demo" mode.

The history list, async job list, and "open PDF" buttons all already fetch with the token (they call `/history`, `/job/:id`, `/pdf/oss/:slug` — all of which are now owner-scoped by mu-004 / mu-005 / mu-006). This issue just plumbs the token through and adds the 401-toast UX (US-5.4).

## Acceptance criteria

- [ ] Settings panel has a "User Token" field below the existing "API Key" field, persists in `localStorage` as `cfg.userToken`.
- [ ] A "Test token" button hits `GET /healthz` with the token; the response shows the resolved user id.
- [ ] All `fetch()` calls in `frontend/index.html` carry `Authorization: Bearer <cfg.userToken>` when set.
- [ ] `EventSource` calls use `?token=<…>` when the user-token path is in use; the `?key=<DEMO_SECRET>` path is preserved for the admin demo.
- [ ] 401 responses show a single toast "Token rejected — contact admin" and disable the chat input (US-5.4).
- [ ] In the open-demo mode (no token, `DEMO_SECRET` empty server-side), the UI works unchanged — system user fallback.
- [ ] e2e: open the chat UI in two Chrome profiles (per the project's `MUST pop open human e2e tests in a named Chrome profile` rule), each with its own token, and prove the two profiles see different histories.

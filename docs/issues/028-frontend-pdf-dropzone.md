# ISSUE-028 — Frontend: drop zone accepts `.pdf` (mock: new endpoint)

## Why
Today the chat UI's drop zone (frontend/index.html:1034 `submitPdfFile`,
line 375 `accept=".md,.markdown,.html,.htm,..."`) only accepts text
formats. This issue adds `.pdf` to the accept list and routes `.pdf` files
through the new `POST /pdf/api/convert` endpoint (ISSUE-026 + ISSUE-027).

Per `/to-issues` mock-tracking: the new endpoint is in ISSUE-026's mock
state (returns 501 for `.md`, echoes `.pdf` unchanged), so this issue
ships the UI without waiting on the real codex runner.

## Scope
- `frontend/index.html:375` — extend the `accept=` attribute to
  include `application/pdf,.pdf`.
- `frontend/index.html:1028-1073` — `handlePdfFilePick` / `submitPdfFile`:
  if `file.type === 'application/pdf'`, POST to `/pdf/api/convert`
  instead of `/pdf/from-file`. For all other types, keep the existing
  `/pdf/from-file` path.
- `frontend/index.html:1065-1098` — the response-rendering path
  (`renderPdfCard` and friends) must handle the new endpoint's two
  response shapes: `application/pdf` binary **or**
  `{ ok, ossUrl, slug }` JSON. Reuse the same renderer.
- Error rendering: when the new endpoint returns 5xx JSON with
  `stderr_tail`, surface it in a `<details>` block (the same pattern
  the chat-UX just adopted in commit `bff3161`).
- Localize: error strings stay zh-CN, matching the rest of the page.

## Mock contract (what frontend writes against)
ISSUE-026 returns:
- 200 + `application/pdf` for `.pdf` input (mock passes through)
- 501 + JSON for `.md` input (mock "not wired yet")

The frontend should:
- Render the PDF preview normally on 200.
- On 501 (mock state), show a clear "暂不支持 .md / .html — codex 接入中"
  banner. **Do not** show the raw stderr_tail during mock state.

## Acceptance criteria
- [ ] Drag a `.pdf` file onto the drop zone → preview renders, opens in
      iframe.
- [ ] Drag a `.md` file (current behavior) → still works through
      `/pdf/from-file`, no regression.
- [ ] When the new endpoint is in mock state (returns 501), a friendly
      zh-CN banner appears, not a raw error.
- [ ] When the new endpoint is fully wired (post-ISSUE-027), `.md` /
      `.html` files routed through `/pdf/api/convert` produce a valid
      PDF preview identical to the existing flow.

## Out of scope
- Real codex wiring (ISSUE-027).
- Streaming/progress feedback (later; per NG-3 in the PRD).

## Downstream consumer test
This is the slice that *tests* ISSUE-026's mock: by dragging a `.md` to
the drop zone and observing the 501 → banner, we prove the route is
actually wired. That's the contract pin that lets ISSUE-026 close.

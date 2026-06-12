# ISSUE-030 — Audit: residual mocks, swallowed stderr, hidden fixtures (sweep)

## Why
The `/to-issues` mock-tracking flow mandates a final audit issue: a
smoke check for "all possible mocks that could remain hidden". Two
real concerns collide here:

1. **Mock residue** from the ISSUE-026/027/029 wave.
2. **stderr-swallow bug B** from the image-2 PDF survey — affects the
   *existing* `/pdf/from-file` and `/pdf/from-url` endpoints (the new
   `/pdf/api/convert` from the PRD pins `stderr_tail` correctly, but
   the old endpoints still call `sanitizePdfError` which discards the
   last 1500 bytes of the runPdfScript stderr).

This audit issue covers both in one sweep.

## Scope

### A. Mock residue sweep
```bash
rg -n 'mock:|FIXME.*replace|hardcoded|TODO.*real' \
   server/ frontend/ scripts/ migrations/ \
   --type-not html
```
Every hit must be either:
- Closed (linked to a closed issue / merged PR), **or**
- Re-opened / tracked in a new issue.

### B. Stderr exposure on the *existing* PDF endpoints
The existing `handlePdfUrl` (server.js:995) and `handlePdfUpload`
(server.js:1046) end with `sanitizePdfError(e)` (server.js:951-970)
which throws a sanitized message. The `catch` block in the handler
replies with `{ok: false, error: <sanitized>}` and the rich stderr is
**never persisted with the response**.

Fix: persist the raw stderr in the JOBS map (or a new
`PDF_RUN_ERRORS` map keyed by slug), and add a new
`GET /pdf/api/errors/:slug` endpoint that returns the last error
JSON. The frontend (ISSUE-028) renders this in a `<details>` block
following the chat-UX `bff3161` pattern.

### C. Hidden fixtures sweep
```bash
rg -n 'sample\.(md|pdf|html)|fixture|TODO.*real' tests/ server/ frontend/
```
Anything that's a hard-coded fixture used by tests must be checked
into `tests/fixtures/` and referenced by relative path.

## Acceptance criteria
- [ ] `rg 'mock:|FIXME.*replace|hardcoded fixture' ...` returns zero
      hits in production code paths (test fixtures are allowed and
      tracked).
- [ ] `GET /pdf/api/errors/:slug` returns `{ok, error, message, stderr_tail, exitCode, durationMs}`
      for the last failed run of that slug.
- [ ] The existing `/pdf/from-file` and `/pdf/from-url` 5xx responses
      now include `stderr_tail` (currently they don't — bug B).
- [ ] Frontend renders the `stderr_tail` in a `<details>` block for
      the existing endpoints too (not just the new one).

## Out of scope
- Async / SSE progress for the existing endpoints (separate slice).
- Per-user isolation (separate PRD).

## Blocked by
- ISSUE-029 (real codex runner swapped in — the audit's contract
  surface assumes the new path is live).

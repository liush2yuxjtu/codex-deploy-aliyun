# ISSUE-026 — `/pdf/api/convert` contract + handler skeleton (mock: codex)

## Why
First vertical slice for `PRD-paste-pdf-api.md`. Ships the HTTP surface so
frontend, curl, and downstream issues can be developed in parallel against a
typed stub. Per the global `/to-issues` rule, we mock the upstream contract
(the codex exec invocation) so this slice does not block on
ISSUE-027 (the codex runner).

## Scope
- Add `POST /pdf/api/convert` and `GET /pdf/api/health` to `server/server.js`
  route table (line 1854-1963 area).
- `checkAuth(req)` gate, mirroring `/run` / `/run-async` (line 1888/1894).
- Multipart parser: accept `file` field (`.md`/`.markdown`/`.html`/`.htm`/
  `.pdf`), `slug`, `format`, `model`.
- Write upload to `/tmp/codex-pdf-in.<rand>.<ext>`. Stub the conversion by
  calling a `runCodexForPdf(filePath, opts)` function that **this issue
  implements as a mock** — for now it just returns the input file
  unchanged if the extension is `.pdf`, or returns a 501 with
  `{ "ok": false, "error": "mock: codex runner not yet wired", "stderr_tail": "" }`
  for everything else.
- Reuse `uploadPdfToOss` + `/pdf/oss/:slug` flow (server.js:881, 1107) for
  the response.
- 5xx response shape must include `stderr_tail` and `exitCode` even when
  empty (so the contract is stable for downstream).

## Mock surface (what the next issue replaces)
```js
// server/server.js — module-level function
async function runCodexForPdf(filePath, { model, format, slug }) {
  // MOCK: returns the file as-is for .pdf, errors for everything else.
  // Real impl: see ISSUE-027, which spawns `codex exec` and pipes the
  // md-to-pdf-webfirst skill. This mock's signature is the contract.
}
```

## Acceptance criteria
- [ ] `curl -F file=@tests/fixtures/sample.pdf -X POST http://.../pdf/api/convert -o out.pdf`
      returns 200, application/pdf, `out.pdf` byte-equals the input.
- [ ] `curl -F file=@tests/fixtures/sample.md -X POST http://.../pdf/api/convert`
      returns 501 with JSON `{ok:false, error:"mock: codex runner not yet wired", stderr_tail:"", exitCode:1, durationMs:N}`.
- [ ] `curl http://.../pdf/api/health` returns 200 with
      `{ok, sandboxUser, codexBin, skillInstalled, model}` (model from `defaultModel`).
- [ ] When `SHARED_SECRET` is set, `checkAuth` blocks the endpoint
      (verify by passing / not passing `?key=` or `x-demo-key` header).
- [ ] Frontend still works (no regression on `/pdf/from-url` /
      `/pdf/from-file`).

## Out of scope
- Actual codex exec invocation (ISSUE-027).
- Frontend drop-zone updates (ISSUE-028).
- Async / SSE progress (later).

## Downstream consumer test
This issue's mock **must** be tested by a downstream consumer. ISSUE-028
(frontend) will write a Playwright check that drags a `.md` file to the drop
zone and expects a 501 from the mock; that's the contract-pinning test.

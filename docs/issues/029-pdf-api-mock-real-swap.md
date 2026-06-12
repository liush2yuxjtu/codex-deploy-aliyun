# ISSUE-029 — mock→real swap: replace ISSUE-026's `runCodexForPdf` mock with ISSUE-027's real impl

## Why
The mock-tracking flow from `/to-issues` requires an explicit
mock→real sweep after the parallel waves land. ISSUE-026 shipped a
`runCodexForPdf` mock; ISSUE-027 shipped the real impl. This issue
wires them together: removes the mock, lets the handler call the real
function, re-runs the full e2e to confirm the contract pin still holds.

## Scope
- `server/server.js` — remove the mock body of `runCodexForPdf`, leave
  only the JSDoc + signature.
- Verify that the import / call site in `handlePdfConvert` (the
  ISSUE-026 handler) still compiles (`node -c`).
- Re-run `scripts/ecs-code-deploy.sh` end-to-end.
- Re-run ISSUE-026's curl acceptance:
  - `curl -F file=@tests/fixtures/sample.md` → **200, application/pdf**
    (was 501 mock before).
  - `curl -F file=@tests/fixtures/sample.pdf` → **200, application/pdf**
    (was 200 passthrough before; should still work).
- Re-run ISSUE-028's Playwright check end-to-end.

## Acceptance criteria
- [ ] `runCodexForPdf` body is the ISSUE-027 impl, not the ISSUE-026 mock.
- [ ] `node -c server/server.js` passes.
- [ ] Both curl cases return 200 + application/pdf.
- [ ] `/healthz` still ok=true, db.ok=true.
- [ ] No residual `mock:` strings or `FIXME: replace with real` markers
      in `server/server.js` (the ISSUE-030 audit covers the wider sweep).

## Blocked by
- ISSUE-026 (handler exists)
- ISSUE-027 (real runner exists)
- ISSUE-028 (frontend wires the route)

## Parallel with
- All other `mock→real` swaps (none in this PRD — single mock, single
  swap).

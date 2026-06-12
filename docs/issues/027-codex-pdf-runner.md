# ISSUE-027 — `runCodexForPdf`: real codex exec wrapper (mock: codex binary)

## Why
ISSUE-026 ships a handler that calls a mock `runCodexForPdf`. This issue
replaces the mock with a real `codex exec` invocation that drives the
`md-to-pdf-webfirst` skill. Per `/to-issues` mock-tracking, we mock the
codex CLI itself (assume it's installed) so the slice doesn't depend on
ISSUE-028 (frontend) or ISSUE-026 landing first.

## Scope
- Implement `runCodexForPdf(filePath, { model, format, slug })` in
  `server/server.js` (or a new `server/codex-pdf-runner.js` if size
  warrants; pick the inline path for v1).
- Spawn `codex` as the `codexsbx` user (use the same `spawnAsSandbox` /
  `setuid` helper the existing `runCodexStreaming` uses at server.js:496+).
- Command: `codex exec -s workspace-write -m <model> --skill md-to-pdf-webfirst <filePath>`.
- Drop the input file into `codexsbx`'s workspace under
  `/tmp/codex-pdf-in/<slug>/` (mirror path on both sides) so the skill can
  find it.
- Collect `stdout` + `stderr` from the child. On non-zero exit, attach
  the last ≤ 1024 bytes of stderr to the rejection so ISSUE-026's
  response shape can populate `stderr_tail`.
- On zero exit, locate the produced PDF (`/tmp/codex-pdf-out/<slug>.pdf`
  by convention, or scan stdout for a "PDF written to …" line the skill
  emits). Resolve with the file path.
- Honor a per-request timeout (default 5 min — see C2 in the PRD).

## Mock surface (contract this slice implements)
Replaces the mock from ISSUE-026. **Signature must not change** — that
is the only guarantee downstream consumers have.

```js
async function runCodexForPdf(filePath, { model, format, slug })
  -> { pdfPath: string, durationMs: number, exitCode: 0, stderrTail: '' }
  throws { stderrTail: string, exitCode: number, durationMs: number }
```

## Acceptance criteria
- [ ] With a real `codex` install + `md-to-pdf-webfirst` skill present on
      the SWAS box, `runCodexForPdf` on a sample `.md` produces a valid
      PDF in `/tmp/codex-pdf-out/`.
- [ ] With an invalid `model` argument, the spawned codex exits non-zero
      and the rejection carries a non-empty `stderrTail`.
- [ ] Function is **testable in isolation** by mocking the child_process
      spawn — write a unit test that injects a fake spawner and verifies
      both success and failure paths.
- [ ] No regression on `runCodexStreaming` (the chat-UX path).

## Out of scope
- HTTP handler (ISSUE-026 owns that).
- Frontend drop-zone accept (ISSUE-028).
- Surfacing stderr to the *existing* `/pdf/from-file` / `/pdf/from-url`
  endpoints (ISSUE-030, follow-up).

## Downstream consumer test
The unit test described above is the contract pin. Also: ISSUE-026 will
be re-run end-to-end and the `curl` cases must flip from "501 mock
error" to "200 real PDF" — that's the integration test.

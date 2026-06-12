# PRD: Paste-API for .md / .pdf → PDF (via codex sandbox + codex skills)

> **Status:** draft · **Owner:** codex-deploy-aliyun · **Created:** 2026-06-12
> **Source intent:** "we need to allow for API call to use paste the .md and .pdf to our server to convert it to PDF via coedx sandbox + codex skills"
> **Replaces:** none (additive; current `/pdf/from-url` + `/pdf/from-file` stay)

## §0 Context — why this PRD exists

Today `/pdf/from-url` and `/pdf/from-file` exist, but they have three limitations the
user wants to lift:

1. **No "paste a PDF to get a PDF back" flow.** A user with an existing .pdf (say, a
   Markdown-rendered report from another tool) cannot use the demo to enrich,
   re-render, or convert it through the codex skill pipeline.
2. **The conversion is direct, not codex-mediated.** `runPdfScript` (server.js:972)
   calls `python3.11 md_to_pdf_webfirst.py` directly, sidestepping the `codex
   exec` sandbox that the rest of the chat run path uses. The user explicitly
   wants conversion to go *through* `codex -s workspace-write` so it inherits
   the same isolation, logging, model layer, and skill-routing that `/run` gets.
3. **No programmatic / API-only path.** Today the only way to invoke PDF gen is
   through the chat UI's drag-drop. External clients (curl, scripts, the future
   supabase bridge the user is exploring) have no documented endpoint.

## §1 Goals

- **G1.** Expose a single `POST /pdf/api/convert` endpoint that accepts either
  a pasted `.md` (or `.html`) text body **or** an uploaded `.pdf` file, and
  returns a PDF (binary stream or presigned OSS URL, same convention as
  today's `/pdf/from-file`).
- **G2.** The conversion must run inside the `codexsbx` user sandbox via
  `codex exec` (not direct python). The codex invocation will call the
  `md-to-pdf-webfirst` skill by name.
- **G3.** The new endpoint follows the same auth pattern as `/run` /
  `/run-async` (gated by `checkAuth` when `DEMO_SECRET` is set; pass-through
  otherwise — matches existing v1 demo behavior).
- **G4.** The new endpoint is reachable from the existing chat UI's drop zone
  (add a `.pdf` accept) and from `curl` / `fetch` scripts.
- **G5.** Errors and stderr from the codex call surface to the client (closes
  the bug B from the image-2 PDF survey, for this new endpoint at minimum).

## §2 Non-goals (out of scope for this PRD)

- **NG1.** Replacing the existing `/pdf/from-url` / `/pdf/from-file` handlers.
  They stay. The new endpoint is additive.
- **NG2.** Per-user isolation, multi-tenant auth, token-based access. The
  isolation PRD (option A/B/C/D in the survey) is a separate decision.
- **NG3.** Async / SSE-streamed progress for the new endpoint. The image-2
  survey flagged "PDF 进度黑屏" as a real bug, but solving it for the existing
  endpoints is a separate slice; this PRD only requires the new endpoint to
  surface stderr on failure.
- **NG4.** Supabase-side storage of the resulting PDFs. The user is exploring
  supabase separately; this PRD just emits the same OSS-or-binary contract
  the existing endpoints do.

## §3 User stories

- **US-1.** As a CLI user, I can `curl -F file=@in.md http://.../pdf/api/convert
  -o out.pdf` and get a PDF.
- **US-2.** As a chat-UI user, I can drag a `.pdf` (not just `.md`/`.html`)
  onto the existing drop zone and get back a "re-rendered" PDF.
- **US-3.** As a developer reading this PRD, I can find the route,
  middleware chain, codex invocation pattern, and error contract documented
  in one place.

## §4 API contract

### `POST /pdf/api/convert`

**Request** (multipart, field name `file`):

| Field     | Type   | Required | Notes                                                  |
|-----------|--------|----------|--------------------------------------------------------|
| `file`    | blob   | yes      | `.md` / `.markdown` / `.html` / `.htm` / `.pdf`       |
| `slug`    | text   | no       | Cache key for `/pdf/oss/:slug` lookup, default random  |
| `format`  | text   | no       | `pdf` (default) or `html` (echo input as HTML wrapper)  |
| `model`   | text   | no       | Codex model override; default = server's `defaultModel` |

**Response 200**:
- `Content-Type: application/pdf` (or `application/json` with `{ ok, ossUrl }` if
  OSS bucket is configured, same convention as existing `/pdf/from-file`).
- Body: PDF binary, or `{ "ok": true, "ossUrl": "https://...", "slug": "..." }`.

**Response 4xx / 5xx** (all JSON):
```json
{
  "ok": false,
  "error": "short label",
  "message": "human-readable summary",
  "stderr_tail": "<last ≤1KB of codex run stderr>",
  "exitCode": 1,
  "durationMs": 47213
}
```

### `GET /pdf/api/health`

A small probe: returns `{ ok, sandboxUser, codexBin, skillInstalled, model }`.
Lets external clients fail-fast on misconfiguration.

## §5 Architecture

```
                ┌─────────────────────────┐
client  ─POST─▶ │ /pdf/api/convert         │
                │  (server.js, new route)  │
                └──────────┬───────────────┘
                           │
                           ▼
                ┌─────────────────────────┐
                │ checkAuth(req)           │  ← if SHARED_SECRET set
                └──────────┬───────────────┘
                           ▼
                ┌─────────────────────────┐
                │ writeUploadToTmp(file)   │  ← /tmp/codex-pdf-in.<rand>.<ext>
                └──────────┬───────────────┘
                           ▼
                ┌─────────────────────────┐
                │ runCodexForPdf(input,    │  ← NEW
                │    slug, model)          │
                │  spawn('codex', 'exec',  │
                │    '-s', 'workspace-    │
                │     write',             │
                │    '-m', model,         │
                │    '--skill',           │
                │    'md-to-pdf-webfirst',│
                │    input)               │
                └──────────┬───────────────┘
                           │
                           ▼
                ┌─────────────────────────┐
                │ collect stdout/stderr    │  ← both buffered; stderr_tail
                │ wait for child 'close'   │     attached to 5xx responses
                └──────────┬───────────────┘
                           ▼
                ┌─────────────────────────┐
                │ uploadPdfToOss / stream  │  ← reuse existing helpers
                └─────────────────────────┘
```

`runCodexForPdf` is a new module-level function (in `server.js` or a new
`server/codex-pdf-runner.js` if we want to keep the surface area clean).
It reuses the same patterns as the existing `runCodexStreaming` (SSE + JOBS
map) but for a synchronous one-shot PDF render.

## §6 Constraints & risks

- **C1.** Codex CLI must be on PATH for the `codexsbx` user. The `codex-api`
  service runs as `root` and drops to `codexsbx` for sandboxed commands; we
  must verify `codex` is on `codexsbx`'s PATH (not just root's).
- **C2.** Codex exec time. Current `runPdfScript` `PDF_TIMEOUT_MS = 180_000`
  (3 min). Codex exec adds overhead (model handshake, skill load). May need
  to raise to 5 min for cold starts. Add a per-request timeout param.
- **C3.** The chat-UX survey (image #2) showed stderr is actively swallowed
  for the *existing* PDF endpoints. This PRD only requires surfacing stderr
  for the *new* endpoint. Fixing the existing endpoints is ISSUE-026 (a
  follow-up).
- **C4.** Cost. Running through `codex exec` invokes the model layer. Even
  for a pure PDF re-render, codex will spin the model. Each request = 1+
  LLM call. The user accepted "demo with public auth" already; this adds a
  new cost vector.
- **C5.** The endpoint is unauthenticated (when `DEMO_SECRET` is empty) by
  v1 demo convention. Whoever picks up the isolation PRD (option C/D) will
  need to fold this new endpoint into the same auth scope.

## §7 Success criteria

- **SC-1.** `curl -F file=@tests/fixtures/sample.md http://.../pdf/api/convert
  -o out.pdf` returns 200, application/pdf, file is a valid PDF.
- **SC-2.** `curl -F file=@tests/fixtures/sample.pdf http://.../pdf/api/convert
  -o out.pdf` returns 200, application/pdf, output opens cleanly.
- **SC-3.** Forcing a codex failure (e.g. invalid model name) returns 5xx
  JSON with `stderr_tail` populated.
- **SC-4.** Frontend drop zone accepts `.pdf` and routes through the new
  endpoint (no regression on `.md` / `.html`).
- **SC-5.** `GET /pdf/api/health` returns 200 with all four fields.

## §8 Open questions

- **OQ-1.** Should `/pdf/api/convert` accept `.pdf` *as input* (re-render
  through codex) or only as output? The current draft assumes both. The
  re-render path may need to extract text from PDF first via the
  `md-to-pdf-webfirst` skill's `--from-pdf` flag (TBD — needs a codex skill
  version check).
- **OQ-2.** Should the response stream PDF bytes or always return
  `application/json` with `ossUrl`? Mixing the two based on OSS availability
  (current convention) is the path of least surprise, but a future PR
  could normalize to always-OSS.
- **OQ-3.** How does the codex exec invocation pass the input file path?
  Codex exec takes a *prompt*, not a file path. The skill needs to know
  where the file landed. Two options: (a) pass the file path in the prompt
  text; (b) add the file to the workspace and let the skill discover it.
  (b) is cleaner but needs workspace-write scope to be a sub-dir of
  /tmp/codex-pdf-in/.

## §9 Anti-patterns (for whoever picks this up)

- **AP-1.** Do NOT call `python3.11 md_to_pdf_webfirst.py` directly. The whole
  point of this PRD is to route through codex.
- **AP-2.** Do NOT silently swallow stderr. The image-2 survey bug B is in
  scope for the *new* endpoint; do not propagate the pattern.
- **AP-3.** Do NOT add per-user auth here. Wait for the isolation PRD.
- **AP-4.** Do NOT bump `PDF_TIMEOUT_MS` for the existing endpoints in this
  PR. Only the new endpoint gets its own timeout knob.

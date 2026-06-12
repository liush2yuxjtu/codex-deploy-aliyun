// codex-api: thin HTTP wrapper that runs `codex exec` as the codexsbx user
// inside a fresh per-request tmpdir, with codex's built-in sandbox enabled.
// Also proxies to the local md-to-pdf-webfirst skill for /pdf requests.
//
// POST /run           body: { prompt, apiKey, model?, timeoutSec? }
//   -> 200 { ok, exitCode, runId, durationMs, stdout, stderr }
// POST /pdf           body: { url, slug? }            -> application/pdf
// POST /pdf/upload    multipart, field "file"        -> application/pdf
// GET  /healthz, GET /
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT          = parseInt(process.env.PORT || '3030', 10);
const SHARED_SECRET = process.env.DEMO_SECRET || ''; // empty = no auth
const SECRET_FILE = '/etc/codex-api/secret.env';
let RDS_HOST='', RDS_PORT=5432, RDS_DB='', RDS_USER='', RDS_PASSWORD='';
let SERVER_LLM_API_KEY = '';
let SERVER_LLM_DEFAULT_MODEL = '';
try {
  const txt = require('fs').readFileSync(SECRET_FILE, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'LLM_API_KEY') SERVER_LLM_API_KEY = m[2].trim();
    if (m[1] === 'LLM_DEFAULT_MODEL') SERVER_LLM_DEFAULT_MODEL = m[2].trim();
    if (m[1] === 'RDS_HOST') RDS_HOST = m[2].trim();
    if (m[1] === 'RDS_PORT') RDS_PORT = parseInt(m[2].trim(), 10) || 5432;
    if (m[1] === 'RDS_DB') RDS_DB = m[2].trim();
    if (m[1] === 'RDS_USER') RDS_USER = m[2].trim();
    if (m[1] === 'RDS_PASSWORD') RDS_PASSWORD = m[2].trim();
  }
  console.log('[codex-api] loaded server LLM key (' + SERVER_LLM_API_KEY.slice(0,12) + '…) default model=' + SERVER_LLM_DEFAULT_MODEL);
} catch (e) {
  console.log('[codex-api] no secret file at', SECRET_FILE, '— requests must supply apiKey');
}

// ─── pg pool (history persistence) ───
let pgPool = null;
if (RDS_HOST && RDS_DB && RDS_USER) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      host: RDS_HOST, port: RDS_PORT, database: RDS_DB,
      user: RDS_USER, password: RDS_PASSWORD,
      ssl: false,
      max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000,
    });
    pgPool.on('error', (e) => console.error('[pg pool error]', e.message));
    console.log('[codex-api] pg pool initialised → ' + RDS_USER + '@' + RDS_HOST + '/' + RDS_DB);
  } catch (e) {
    console.error('[codex-api] pg init failed:', e.message);
    pgPool = null;
  }
} else {
  console.log('[codex-api] no RDS_* env — running without history persistence');
}

async function recordRun(row) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      // ISSUE-014: persist the codex-assigned session id and the
      // parent_session_id when the run was resumed from a previous one.
      // Both columns live in migration 002_codex_runs_session.sql; if the
      // migration hasn't run yet the INSERT will fail and the catch logs
      // the error — we never break the user-facing /run response on
      // persistence failure.
      `INSERT INTO codex_runs(run_id, prompt, model, exit_code, duration_ms, stdout, stderr, ok, error, client_ip, codex_session_id, parent_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.runId, row.prompt, row.model, row.exitCode ?? null,
       row.durationMs ?? null,
       (row.stdout || '').slice(0, 200000),
       (row.stderr || '').slice(0, 40000),
       !!row.ok,
       row.error || null,
       row.clientIp || null,
       row.codexSessionId ?? null,
       row.parentSessionId ?? null]
    );
  } catch (e) {
    console.error('[recordRun] insert failed:', e.message);
  }
}

// ─── codex_jobs persistence (ISSUE-010) ───
// Best-effort INSERT after spawn + UPDATE on terminal state. Failures only
// log; the in-memory JOBS Map remains the source of truth within the 60-min
// TTL. stdout / stderr live as files under /var/lib/codex-runs/<runId>/ —
// RDS stores only their paths.
async function insertCodexJob(row) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO codex_jobs
         (job_id, status, prompt, model, started_at, finished_at,
          duration_ms, exit_code, client_ip, last_event_ts,
          stdout_path, stderr_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        row.jobId, row.status, row.prompt, row.model ?? null,
        row.startedAt, row.finishedAt ?? null,
        row.durationMs ?? null, row.exitCode ?? null,
        row.clientIp ?? null, row.lastEventTs,
        row.stdoutPath, row.stderrPath,
      ]
    );
  } catch (e) {
    console.error('[codexJobs] insert failed:', e.message);
  }
}

async function updateCodexJobTerminal(row) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `UPDATE codex_jobs
          SET status        = $2,
              finished_at   = $3,
              duration_ms   = $4,
              exit_code     = $5,
              last_event_ts = $6
        WHERE job_id = $1`,
      [
        row.jobId, row.status,
        row.finishedAt ?? null,
        row.durationMs ?? null,
        row.exitCode ?? null,
        row.lastEventTs,
      ]
    );
  } catch (e) {
    console.error('[codexJobs] update failed:', e.message);
  }
}

// Mid-flight status update (e.g. queued → running). Used by the ISSUE-013
// semaphore to flip the RDS row when a queued job gets a slot and spawns.
// stdout_path / stderr_path are also updatable so a queued placeholder can
// be replaced by the real per-run workDir paths.
async function updateCodexJobStatus(row) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `UPDATE codex_jobs
          SET status        = $2,
              last_event_ts = $3,
              stdout_path   = COALESCE($4, stdout_path),
              stderr_path   = COALESCE($5, stderr_path)
        WHERE job_id = $1`,
      [
        row.jobId, row.status,
        row.lastEventTs ?? Date.now(),
        row.stdoutPath ?? null,
        row.stderrPath ?? null,
      ]
    );
  } catch (e) {
    console.error('[codexJobs] status update failed:', e.message);
  }
}

// Re-hydrate a read-only job snapshot from RDS for /job/:id on a memory miss.
// Returns null if the row doesn't exist or the DB is unavailable. The returned
// shape mirrors what handleJobStatus writes back (emitter=null, no event
// replay — that path is SSE-only and stays memory-resident).
async function loadJobFromRds(jobId) {
  if (!pgPool) return null;
  try {
    const r = await pgPool.query(
      `SELECT job_id, status, prompt, model, started_at, finished_at,
              duration_ms, exit_code, client_ip, last_event_ts,
              stdout_path, stderr_path
         FROM codex_jobs
        WHERE job_id = $1`,
      [jobId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const stateMap = {
      queued: 'pending', running: 'running', firstByte: 'running',
      done: 'done', error: 'error', cancelled: 'error', timeout: 'error',
    };
    const s = row.status;
    return {
      id: row.job_id,
      state: stateMap[s] || 'error',
      prompt: row.prompt,
      model: row.model,
      started: parseInt(row.started_at, 10),
      finished: row.finished_at != null ? parseInt(row.finished_at, 10) : null,
      durationMs: row.duration_ms != null ? parseInt(row.duration_ms, 10) : null,
      exitCode: row.exit_code,
      clientIp: row.client_ip,
      runId: null,
      spawnMs: null, gatewayMs: null,
      ok: s === 'done',
      error: (s === 'error' || s === 'timeout' || s === 'cancelled')
        ? ('job finished with status=' + s) : null,
      quotaExceeded: false,
      stdout: '', stderr: '',
      stdoutPath: row.stdout_path,
      stderrPath: row.stderr_path,
      lastEvent: { type: s, ts: parseInt(row.last_event_ts, 10) },
      emitter: null,
      subscribers: 0,
      fromRds: true,
    };
  } catch (e) {
    console.error('[codexJobs] load failed:', e.message);
    return null;
  }
}

const CODEX_BIN     = '/opt/node-v20.18.1-linux-x64/bin/codex';
const SANDBOX_USER  = 'codexsbx';
const RUN_BASE      = '/var/lib/codex-runs';

// Codex init: best-effort. If the sandbox user doesn't exist (e.g. running
// on the local Mac dev box), /run returns 503, but the rest of the API
// (including /pdf) still works.
let SANDBOX_UID = 1000, SANDBOX_GID = 1000, CODEX_AVAILABLE = false;
try {
  SANDBOX_UID = parseInt(execFileSync('id', ['-u', SANDBOX_USER]).toString().trim(), 10);
  SANDBOX_GID = parseInt(execFileSync('id', ['-g', SANDBOX_USER]).toString().trim(), 10);
  CODEX_AVAILABLE = fs.existsSync(CODEX_BIN);
} catch (e) {
  console.log('[codex-api] sandbox user ' + SANDBOX_USER + ' not present — /run disabled, /pdf still works');
}
const DEFAULT_TIMEOUT = 90;
const MAX_TIMEOUT     = 900;

// ─── parseCodexSessionId (ISSUE-014) ───
// codex exec --json emits NDJSON events; thread.started carries a UUID that
// is the codex-assigned session id. We scan the buffer once on the
// happy path and once on resume — for a successful resume the event
// re-fires with the SAME id (parent_session_id == codex_session_id of
// the prior run). For a failed resume (session not found / GC'd) the
// id is either absent or new, so the caller can decide to fall back.
//
// Robust to:
//   - multiple JSON lines in a single chunk (we split on \n)
//   - thread id appearing in plain text, not just the JSON event
//     (e.g. error messages like "session 5a31… not found") — first match wins
//   - non-JSON noise (we never throw on a single bad line)
const CODEX_SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function parseCodexSessionId(stdoutOrStderr) {
  if (!stdoutOrStderr) return null;
  const text = String(stdoutOrStderr);
  // First, look for an explicit thread.started JSON line — most reliable.
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      // The CLI's NDJSON shape: { type: "thread.started", thread_id: "..." }
      // or { event: "thread.started", payload: { id: "..." } } depending on
      // version. Accept either.
      const direct = obj.thread_id || obj.session_id || obj.sessionId
        || (obj.payload && (obj.payload.id || obj.payload.session_id));
      if (typeof direct === 'string' && CODEX_SESSION_ID_RE.test(direct)) return direct;
      if (obj.type === 'thread.started' || obj.event === 'thread.started') {
        const id = obj.thread_id || (obj.payload && obj.payload.id);
        if (typeof id === 'string' && CODEX_SESSION_ID_RE.test(id)) return id;
      }
    } catch { /* not JSON, skip */ }
  }
  // Fallback: any UUID-shaped token in the combined text. Less precise but
  // covers cases where codex prints the id outside of a JSON envelope
  // (e.g. on stderr warnings). First match wins.
  const m = text.match(CODEX_SESSION_ID_RE);
  return m ? m[0] : null;
}

// ─── async /run: in-memory job store + per-job EventEmitter for SSE ───
const JOBS = new Map();              // jobId -> { state, emitter, ... }
const JOBS_TTL_MS = 60 * 60 * 1000;  // GC finished jobs after 1h
const EVENTS_RING_MAX = 5000;        // max buffered events per job for replay (ISSUE-011)

function newJobId() { return randomUUID(); }
function makeJob(initial) {
  const emitter = new (require('events'))();
  const job = {
    ...initial,
    emitter,
    subscribers: 0,
    events: [],         // ring buffer of past events; replayed on Last-Event-ID / ?resume=
    eventSeq: 0,        // monotonic counter; surfaces as evt-<n> for clients
  };
  JOBS.set(job.id, job);
  return job;
}
function emitJob(job, type, payload) {
  job.eventSeq += 1;
  const evt = { id: 'evt-' + job.eventSeq, type, ts: Date.now(), ...payload };
  job.lastEvent = evt;
  // ring buffer: bounded so a runaway job can't OOM the process. Drop the
  // oldest when over the cap; clients resuming past the cap fall back to
  // RDS (see handleJobEvents).
  if (job.events.length >= EVENTS_RING_MAX) job.events.shift();
  job.events.push(evt);
  job.emitter.emit('event', evt);
  return evt;
}
function gcJob(job) {
  setTimeout(() => { if (JOBS.get(job.id) === job) JOBS.delete(job.id); }, JOBS_TTL_MS).unref();
}

// ─── concurrency semaphore + FIFO queue (ISSUE-013) ───
// Cap concurrent codex jobs to MAX_CONCURRENT_CODEX (default 3, env).
// Excess requests join a FIFO queue of MAX_QUEUE_SIZE (default 6, env).
// Queue entries that wait more than MAX_QUEUE_WAIT_MS (30s) are rejected
// with 503 queue_timeout; their child (if any) is killed via killJobTree.
const MAX_CONCURRENT_CODEX = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CODEX || '3', 10) || 3);
const MAX_QUEUE_SIZE       = Math.max(0, parseInt(process.env.MAX_QUEUE_SIZE || '6', 10) || 6);
const MAX_QUEUE_WAIT_MS    = 30 * 1000;
let activeCount = 0;
const queue = [];   // [{ jobId, resolve, reject, timer, queuedAt }]

function tryAcquireSlot() {
  if (activeCount < MAX_CONCURRENT_CODEX) {
    activeCount += 1;
    return { acquired: true, mode: 'running' };
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    return { acquired: false, mode: 'rejected', reason: 'queue_full' };
  }
  return { acquired: false, mode: 'queued' };
}
function waitForSlot({ jobId }) {
  return new Promise((resolve, reject) => {
    const entry = { jobId, resolve, reject, queuedAt: Date.now(), timer: null };
    entry.timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx === -1) return;
      queue.splice(idx, 1);
      const e = new Error('queue timeout after ' + MAX_QUEUE_WAIT_MS + 'ms');
      e.queueReason = 'queue_timeout';
      e.queueWaitMs = Date.now() - entry.queuedAt;
      reject(e);
    }, MAX_QUEUE_WAIT_MS);
    entry.timer.unref?.();
    queue.push(entry);
  });
}
function drainQueue() {
  while (activeCount < MAX_CONCURRENT_CODEX && queue.length > 0) {
    const next = queue.shift();
    if (next.timer) clearTimeout(next.timer);
    activeCount += 1;
    next.resolve({ mode: 'running' });
  }
}
function releaseSlot() {
  if (activeCount > 0) activeCount -= 1;
  drainQueue();
}
function cancelQueueWait(jobId, reason = 'cancelled') {
  const idx = queue.findIndex(e => e.jobId === jobId);
  if (idx === -1) return false;
  const entry = queue.splice(idx, 1)[0];
  if (entry.timer) clearTimeout(entry.timer);
  const e = new Error('queue wait cancelled: ' + reason);
  e.queueReason = reason;
  entry.reject(e);
  return true;
}
function queueStats() {
  return {
    active: activeCount,
    queued: queue.length,
    maxConcurrent: MAX_CONCURRENT_CODEX,
    maxQueue: MAX_QUEUE_SIZE,
    maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
  };
}

// ─── killJobTree: SIGTERM → wait gracefulMs → SIGKILL on the process group ───
// Used by ISSUE-002/004/013/014. codex's Rust binary detaches from the JS
// launcher, so we must signal the process group (negative pid), see
// reference-deployment-gotchas #6. Pure helper: no side-effects on JOBS.
async function killJobTree(child, { gracefulMs = 5000, jobId = '-', reason = 'user' } = {}) {
  if (!child) {
    return { killed: false, reason: 'no_child' };
  }
  const pid = child.pid;
  const log = (sig, why) => console.log(`[killJobTree] job=${jobId} pid=${pid} sig=${sig} reason=${why}`);

  // Helper: signal the process group; fall back to direct kill if the group
  // is gone. Bubbles ESRCH so the caller can map to "already_dead".
  const signal = (sig) => {
    try { process.kill(-pid, sig); return 'pg'; }
    catch (e) {
      if (e && e.code === 'ESRCH') throw e;
      try { child.kill(sig); return 'direct'; }
      catch (e2) { if (e2 && e2.code === 'ESRCH') throw e2; throw e2; }
    }
  };

  // 1) try SIGTERM
  try { signal('SIGTERM'); }
  catch (e) {
    if (e && e.code === 'ESRCH') {
      log('TERM', 'already_dead');
      return { killed: false, reason: 'already_dead' };
    }
    throw e;
  }
  log('TERM', reason);

  // 2) wait for graceful exit, capped at gracefulMs
  const exited = await new Promise((resolve) => {
    let done = false;
    const finish = (how) => { if (done) return; done = true; clearTimeout(t); resolve(how); };
    const t = setTimeout(() => finish('timeout'), gracefulMs);
    child.once('exit', () => finish('exit'));
  });

  if (exited === 'exit') {
    return { killed: true, sig: 'TERM' };
  }

  // 3) graceful timed out → SIGKILL the group
  try { signal('SIGKILL'); }
  catch (e) {
    if (e && e.code === 'ESRCH') {
      log('KILL', 'already_dead');
      return { killed: false, reason: 'already_dead' };
    }
    throw e;
  }
  log('KILL', 'timeout');
  return { killed: true, sig: 'KILL' };
}

// Shared spawn helper used by both handleRun (sync) and handleRunAsync.
// Returns { child, runId, workDir, started, sessionId }.
// ISSUE-014: when `sessionId` is supplied, the command becomes
//   `codex exec resume <sid> <prompt>` instead of `codex exec ... <prompt>`.
// The sessionId is returned on the spawn object so the caller can record
// it as `parent_session_id` on the new codex_runs row.
function startCodexJob({ prompt, effectiveKey, effectiveModel, timeoutS, clientIp, sessionId }) {
  const runId = randomUUID();
  const workDir = path.join(RUN_BASE, runId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o770 });
  try {
    const { execSync } = require('child_process');
    execSync(`chown ${SANDBOX_USER}:${SANDBOX_USER} ${workDir}`);
  } catch {}

  // ISSUE-014: the binary needs `codex exec resume <sid> <prompt>` (0.139.0+).
  // Trim defensively; reject empty strings so a bad client doesn't silently
  // downgrade to a fresh session.
  const trimmedSession = (sessionId || '').toString().trim();
  const codexArgs = [
    trimmedSession ? 'exec' : 'exec',
    '--ignore-user-config',
    '-c', 'model_provider="newcli"',
    '-c', 'model_providers.newcli.name="newcli"',
    '-c', 'model_providers.newcli.base_url="https://code.newcli.com/codex/v1"',
    '-c', 'model_providers.newcli.wire_api="responses"',
    '-c', 'model_providers.newcli.env_key="LLM_API_KEY"',
    '-c', 'model_providers.newcli.request_max_retries=1',
    '-c', 'model_providers.newcli.stream_max_retries=1',
    '-c', 'disable_response_storage=true',
    '-c', 'approval_policy="never"',
    '-s', 'workspace-write',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '-C', workDir,
  ];
  if (effectiveModel) codexArgs.push('-m', effectiveModel);
  if (trimmedSession) {
    // Resume path: `codex exec resume <sid> <prompt>`
    codexArgs.push('resume', trimmedSession, prompt);
  } else {
    codexArgs.push(prompt);
  }

  const started = Date.now();
  const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/opt/node-v20.18.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: `/home/${SANDBOX_USER}`,
      USER: SANDBOX_USER,
      LLM_API_KEY: effectiveKey,
      OPENAI_API_KEY: effectiveKey,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });
  return { child, runId, workDir, started, sessionId: trimmedSession || null };
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0, chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!SHARED_SECRET) return true;
  const url = new URL(req.url, 'http://x');
  return (req.headers['x-demo-key'] || '') === SHARED_SECRET
      || (url.searchParams.get('key') || '') === SHARED_SECRET;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── /pdf: md/html → PDF via md-to-pdf-webfirst skill ───
const PDF_SKILL_DIR  = process.env.PDF_SKILL_DIR
  || path.join(os.homedir(), '.codex', 'skills', 'md-to-pdf-webfirst');
const PDF_SCRIPT     = path.join(PDF_SKILL_DIR, 'scripts', 'md_to_pdf_webfirst.py');
const PDF_OUTPUT_DIR = process.env.PDF_OUTPUT_DIR
  || path.join(os.tmpdir(), 'codex-pdf-out');
const PDF_TMP_DIR    = path.join(os.tmpdir(), 'codex-pdf-up');
const PDF_TIMEOUT_MS = 180 * 1000; // 3 min for a full skill run

function pdfSlug(input) {
  const base = (input || 'doc').toString()
    .replace(/^https?:\/\/(gist\.)?githubusercontent\.com\/[^/]+\/[^/]+\/raw\//, '')
    .replace(/^https?:\/\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'doc';
  return base;
}

function parseMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const parts = {};
    let buf = Buffer.alloc(0);
    req.on('data', c => { buf = Buffer.concat([buf, c]); if (buf.length > 50 * 1024 * 1024) { req.destroy(); reject(new Error('upload too large')); } });
    req.on('end', () => {
      const delim = Buffer.from('--' + boundary);
      let i = 0;
      while (i < buf.length) {
        const next = buf.indexOf(delim, i);
        if (next === -1) break;
        i = next + delim.length;
        const end = buf.indexOf(delim, i);
        const slice = end === -1 ? buf.slice(i) : buf.slice(i, end);
        if (slice.length === 0) break;
        const cleaned = slice.subarray(slice[0] === 0x0d && slice[1] === 0x0a ? 2 : 0,
          slice.length - (slice.length >= 2 && slice[slice.length - 2] === 0x0d && slice[slice.length - 1] === 0x0a ? 2 : 0));
        const headerEnd = cleaned.indexOf('\r\n\r\n');
        if (headerEnd === -1) { i = end === -1 ? buf.length : end; continue; }
        const header = cleaned.subarray(0, headerEnd).toString('utf8');
        const body   = cleaned.subarray(headerEnd + 4);
        const nameM  = header.match(/name="([^"]+)"/);
        const fileM  = header.match(/filename="([^"]+)"/);
        const ctM    = header.match(/Content-Type:\s*([^\r\n]+)/i);
        if (nameM) parts[nameM[1]] = { filename: fileM ? fileM[1] : null, contentType: ctM ? ctM[1].trim() : null, data: body };
        i = end === -1 ? buf.length : end;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

// Map skill/IO errors to one-line client-safe messages. Full stderr stays in journalctl.
function sanitizePdfError(err, kind) {
  const msg = String(err && err.message || err || '');
  console.error('[pdf:' + kind + ']', msg);  // full detail server-side
  if (/SSL_ERROR_SYSCALL|SSL_connect|certificate|ECONN|ENOTFOUND|getaddrinfo/i.test(msg)) {
    return '源 URL 网络失败(ssl/dns/连接)。请检查 URL 是否可访问。';
  }
  if (/HTTP\s*4\d\d|HTTP\s*5\d\d|404|403/i.test(msg)) {
    return '源 URL 返回 4xx/5xx。请确认链接有效。';
  }
  if (/timed?\s*out|timed out after|TimeoutExpired|SIGKILL/i.test(msg)) {
    return 'PDF 生成超时(超过 3 分钟)。请尝试更小的输入或稍后重试。';
  }
  if (/not produced at/i.test(msg)) {
    return 'PDF 技能未产出文件。可能是输入格式不被支持或源页面脚本渲染失败。';
  }
  if (/exited\s+\d+/i.test(msg)) {
    return 'PDF 技能内部失败(详细日志已记录到服务端)。';
  }
  return 'PDF 生成失败(详细日志已记录到服务端)。';
}

async function runPdfScript(inputPath, slug) {
  fs.mkdirSync(PDF_OUTPUT_DIR, { recursive: true });
  const cwd = path.dirname(PDF_SCRIPT);
  const args = [PDF_SCRIPT, '--input', inputPath, '--slug', slug, '--out-dir', PDF_OUTPUT_DIR];
  console.log('[pdf] exec:', PDF_SCRIPT, 'cwd=', cwd, 'args=', args);
  return await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.env.PDF_PYTHON_BIN || 'python3.11', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, PDF_TIMEOUT_MS);
    child.stdout.on('data', c => out += c.toString('utf8'));
    child.stderr.on('data', c => err += c.toString('utf8'));
    child.on('error', e => { clearTimeout(killer); reject(e); });
    child.on('close', code => {
      clearTimeout(killer);
      const pdfPath = path.join(PDF_OUTPUT_DIR, slug + '.pdf');
      if (code !== 0) return reject(new Error('skill exited ' + code + ' — stderr: ' + err.slice(-1500)));
      if (!fs.existsSync(pdfPath)) return reject(new Error('PDF not produced at ' + pdfPath + ' — meta: ' + out.slice(-1500)));
      resolve({ pdfPath, ms: Date.now() - t0 });
    });
  });
}

async function handlePdfUrl(req, res) {
  const raw = await readBody(req);
  let body; try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
  const url = (body.url || body.input || '').toString().trim();
  if (!url) return json(res, 400, { ok: false, error: 'missing url' });
  if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, error: 'url must be http(s)' });
  if (!fs.existsSync(PDF_SCRIPT)) return json(res, 503, { ok: false, error: 'md-to-pdf-webfirst skill not installed at ' + PDF_SKILL_DIR });
  const slug = pdfSlug(body.slug || url);
  try {
    const { pdfPath, ms } = await runPdfScript(url, slug);
    const pdf = fs.readFileSync(pdfPath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': 'attachment; filename="' + slug + '.pdf"',
      'X-Pdf-Ms': String(ms),
    });
    return res.end(pdf);
  } catch (e) {
    return json(res, 500, { ok: false, error: sanitizePdfError(e, 'url') });
  }
}

async function handlePdfUpload(req, res) {
  const ct = (req.headers['content-type'] || '').toString();
  const m = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!m) return json(res, 400, { ok: false, error: 'multipart/form-data with boundary required' });
  const boundary = m[1] || m[2];
  if (!fs.existsSync(PDF_SCRIPT)) return json(res, 503, { ok: false, error: 'md-to-pdf-webfirst skill not installed at ' + PDF_SKILL_DIR });
  const parts = await parseMultipart(req, boundary);
  // Only accept the canonical field names. If the form had any file but not
  // under "file" / "upload", tell the user the right field name.
  const file = parts.file || parts.upload;
  if (!file || !file.filename) {
    const fields = Object.keys(parts);
    const hasAnyFile = fields.some(k => parts[k] && parts[k].filename);
    if (hasAnyFile) return json(res, 400, { ok: false, error: '表单字段名必须是 "file"(或 "upload"),收到的是: ' + fields.filter(k => parts[k] && parts[k].filename).join(', ') });
    return json(res, 400, { ok: false, error: 'no file in upload' });
  }
  const ext = path.extname(file.filename).toLowerCase() || '.html';
  if (!['.md', '.markdown', '.html', '.htm'].includes(ext)) {
    return json(res, 400, { ok: false, error: 'unsupported file type: ' + ext + ' (allowed: .md .markdown .html .htm)' });
  }
  fs.mkdirSync(PDF_TMP_DIR, { recursive: true });
  const safeName = file.filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  const tmpPath = path.join(PDF_TMP_DIR, Date.now() + '-' + safeName);
  fs.writeFileSync(tmpPath, file.data);
  const slug = pdfSlug(path.basename(safeName, ext));
  try {
    const { pdfPath, ms } = await runPdfScript(tmpPath, slug);
    const pdf = fs.readFileSync(pdfPath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': 'attachment; filename="' + slug + '.pdf"',
      'X-Pdf-Ms': String(ms),
    });
    return res.end(pdf);
  } catch (e) {
    return json(res, 500, { ok: false, error: sanitizePdfError(e, 'upload') });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function handleRun(req, res) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
  const prompt    = (body.prompt || '').toString();
  const apiKey    = (body.apiKey || body.openaiApiKey || process.env.DEFAULT_OPENAI_API_KEY || '').toString();
  const model     = (body.model  || process.env.DEFAULT_MODEL || '').toString();
  // ISSUE-014: optional sessionId to continue a previous conversation.
  const sessionId = (body.sessionId || '').toString().trim() || null;
  const requestedTimeoutS = parseInt(body.timeoutSec || DEFAULT_TIMEOUT, 10) || DEFAULT_TIMEOUT;
  if (requestedTimeoutS > MAX_TIMEOUT) {
    return json(res, 400, { ok: false, error: 'bad_timeout', max: MAX_TIMEOUT });
  }
  const timeoutS  = requestedTimeoutS;
  if (!prompt) return json(res, 400, { ok: false, error: 'missing prompt' });
  const effectiveKey = apiKey || SERVER_LLM_API_KEY;
  if (!effectiveKey) return json(res, 400, { ok: false, error: 'missing apiKey: neither request body nor server has one' });
  const effectiveModel = model || SERVER_LLM_DEFAULT_MODEL || '';

  const runId = randomUUID();
  const workDir = path.join(RUN_BASE, runId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o770 });
  // chown to codexsbx so the user can write inside
  try {
    const { execSync } = require('child_process');
    execSync(`chown ${SANDBOX_USER}:${SANDBOX_USER} ${workDir}`);
  } catch (e) { /* best-effort */ }

  // Build the codex command. Every config injected per-call via -c so no
  // shared on-disk state can drift between requests (codex was self-rewriting
  // config.toml with an outdated wire_api on cold start).
  // ISSUE-014: when sessionId is present, the CLI invocation becomes
  //   codex exec resume <sid> <prompt>
  // — see startCodexJob; the args we build here mirror that path.
  const codexArgs = [
    'exec',
    '--ignore-user-config',                                  // do not read ~/.codex/config.toml
    '-c', 'model_provider="newcli"',
    '-c', 'model_providers.newcli.name="newcli"',
    '-c', 'model_providers.newcli.base_url="https://code.newcli.com/codex/v1"',
    '-c', 'model_providers.newcli.wire_api="responses"',     // gateway uses /v1/responses
    '-c', 'model_providers.newcli.env_key="LLM_API_KEY"',
    '-c', 'model_providers.newcli.request_max_retries=1',
    '-c', 'model_providers.newcli.stream_max_retries=1',
    '-c', 'disable_response_storage=true',
    '-c', 'approval_policy="never"',
    '-s', 'workspace-write',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '-C', workDir,
  ];
  if (effectiveModel) codexArgs.push('-m', effectiveModel);
  if (sessionId) {
    codexArgs.push('resume', sessionId, prompt);
  } else {
    codexArgs.push(prompt);
  }

  const started = Date.now();
  const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/opt/node-v20.18.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: `/home/${SANDBOX_USER}`,
      USER: SANDBOX_USER,
      LLM_API_KEY: effectiveKey,
      OPENAI_API_KEY: effectiveKey,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });
  let stdout = '', stderr = '', killed = false;
  let firstByteMs = null;   // ms from spawn to first stdout/stderr byte (proxy for "first model token")
  child.stdout.on('data', c => { if (firstByteMs === null) firstByteMs = Date.now() - started; stdout += c.toString('utf8'); });
  child.stderr.on('data', c => { if (firstByteMs === null) firstByteMs = Date.now() - started; stderr += c.toString('utf8'); });

  const killTimer = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (e) { try { child.kill('SIGKILL'); } catch {} }
  }, timeoutS * 1000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    const durationMs = Date.now() - started;
    const spawnMs   = firstByteMs ?? 0;             // ms from spawn to first byte (Rust cold start + handshake)
    const gatewayMs = firstByteMs != null ? Math.max(0, durationMs - firstByteMs) : 0; // model inference + retries
    const quotaExceeded = /\b(429|too many requests|rate[_ -]?limit)\b/i.test(stderr + stdout);
    // ISSUE-014: pull the codex-assigned session id from the captured
    // stdout/stderr. For a successful resume, the id equals the requested
    // sessionId; for a failed resume (session not found / GC'd) the id
    // will be missing or a new one. We expose both to the client and
    // signal the fallback via `resumed: false` + `fallbackReason`.
    const codexSessionId = parseCodexSessionId(stdout + '\n' + stderr);
    const requestedSessionId = sessionId || null;
    const resumedOk = !!requestedSessionId && code === 0 && !!codexSessionId && codexSessionId === requestedSessionId;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

    let payload, status;
    if (killed) {
      status = 504;
      payload = { ok: false, exitCode: 124, error: 'timeout', runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: resumedOk,
        ...(requestedSessionId && !resumedOk ? { fallbackReason: 'session_not_found' } : {}) };
    } else if (code === 0) {
      status = 200;
      payload = { ok: true, exitCode: code, runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: resumedOk,
        ...(requestedSessionId && !resumedOk ? { fallbackReason: 'session_not_found' } : {}) };
    } else {
      status = 502;
      payload = { ok: false, exitCode: code, runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: false,
        ...(requestedSessionId ? { fallbackReason: 'session_not_found' } : {}) };
    }
    json(res, status, payload);

    // fire-and-forget persistence
    Promise.resolve().then(() => recordRun({
      runId, prompt, model: effectiveModel || null,
      exitCode: payload.exitCode ?? null,
      durationMs, stdout: payload.stdout, stderr: payload.stderr,
      ok: !!payload.ok, error: payload.error || null,
      clientIp,
      codexSessionId: codexSessionId || null,
      parentSessionId: requestedSessionId,
    })).catch(e => console.error('[recordRun outer]', e.message));
  });

  child.on('error', (e) => {
    clearTimeout(killTimer);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    json(res, 500, { ok: false, error: String(e && e.message || e) });
  });
}

// ─── async /run: long-running skill calls (PDF render, web fetch, etc.) ───
// Returns 202 + { jobId, statusUrl, eventsUrl } immediately; client polls
// /job/:id or subscribes to /job/:id/events for live progress.
async function handleRunAsync(req, res) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
  const prompt    = (body.prompt || '').toString();
  const apiKey    = (body.apiKey || body.openaiApiKey || process.env.DEFAULT_OPENAI_API_KEY || '').toString();
  const model     = (body.model  || process.env.DEFAULT_MODEL || '').toString();
  // ISSUE-014: optional sessionId to continue a previous conversation.
  const sessionId = (body.sessionId || '').toString().trim() || null;
  const requestedTimeoutS = parseInt(body.timeoutSec || MAX_TIMEOUT, 10) || MAX_TIMEOUT;
  if (requestedTimeoutS > MAX_TIMEOUT) {
    return json(res, 400, { ok: false, error: 'bad_timeout', max: MAX_TIMEOUT });
  }
  const timeoutS  = requestedTimeoutS;
  if (!prompt) return json(res, 400, { ok: false, error: 'missing prompt' });
  const effectiveKey = apiKey || SERVER_LLM_API_KEY;
  if (!effectiveKey) return json(res, 400, { ok: false, error: 'missing apiKey: neither request body nor server has one' });
  const effectiveModel = model || SERVER_LLM_DEFAULT_MODEL || '';

  const job = makeJob({
    id: newJobId(),
    state: 'pending',                 // pending -> running -> done|error
    prompt, model: effectiveModel || null,
    started: Date.now(), finished: null,
    runId: null, exitCode: null, ok: null,
    spawnMs: 0, gatewayMs: 0, quotaExceeded: false,
    error: null, stdout: '', stderr: '',
    clientIp,
  });
  gcJob(job);

  // ISSUE-013: acquire a concurrency slot. If the semaphore is full, the
  // request joins the FIFO queue (or is rejected with 503 queue_full if the
  // queue itself is at MAX_QUEUE_SIZE). Queue entries that wait longer than
  // MAX_QUEUE_WAIT_MS are rejected with 503 queue_timeout.
  const acquire = tryAcquireSlot();
  if (!acquire.acquired && acquire.mode === 'rejected') {
    res.setHeader('Retry-After', '10');
    return json(res, 503, { ok: false, error: 'queue_full', queue: queueStats() });
  }
  const startedQueued = acquire.mode === 'queued';
  if (startedQueued) job.state = 'queued';
  const placeholderStdout = path.join(RUN_BASE, '__pending__', job.id, 'stdout.log');
  const placeholderStderr = path.join(RUN_BASE, '__pending__', job.id, 'stderr.log');
  Promise.resolve().then(() => insertCodexJob({
    jobId: job.id,
    status: startedQueued ? 'queued' : 'running',
    prompt: job.prompt,
    model: job.model,
    startedAt: job.started,
    lastEventTs: Date.now(),
    stdoutPath: placeholderStdout,
    stderrPath: placeholderStderr,
    clientIp,
  })).catch(e => console.error('[codexJobs insert outer]', e.message));

  if (startedQueued) {
    const pos = queue.length + 1;
    emitJob(job, 'queued', { position: pos, maxConcurrent: MAX_CONCURRENT_CODEX, maxQueue: MAX_QUEUE_SIZE, maxQueueWaitMs: MAX_QUEUE_WAIT_MS });
    json(res, 202, {
      ok: true, async: true, jobId: job.id,
      state: 'queued', queuePosition: pos,
      statusUrl: '/job/' + job.id,
      eventsUrl: '/job/' + job.id + '/events',
      timeoutSec: timeoutS,
    });
    let grant;
    try {
      grant = await waitForSlot({ jobId: job.id });
    } catch (e) {
      await killJobTree(null, { jobId: job.id, reason: 'queue_timeout' });
      job.state = 'error';
      job.ok = false;
      job.error = e.queueReason || 'queue_timeout';
      job.finished = Date.now();
      job.exitCode = null;
      emitJob(job, 'error', { error: job.error, queueReason: e.queueReason, queueWaitMs: e.queueWaitMs });
      Promise.resolve().then(() => updateCodexJobTerminal({
        jobId: job.id,
        status: 'cancelled',
        finishedAt: job.finished,
        durationMs: null,
        exitCode: null,
        lastEventTs: Date.now(),
      })).catch(err => console.error('[codexJobs update outer]', err.message));
      return;
    }
    void grant;
  }

  let spawn;
  try {
    spawn = startCodexJob({ prompt, effectiveKey, effectiveModel, timeoutS, clientIp, sessionId });
  } catch (e) {
    job.state = 'error';
    job.error = String(e && e.message || e);
    job.finished = Date.now();
    emitJob(job, 'error', { error: job.error });
    releaseSlot();
    return json(res, 500, { ok: false, jobId: job.id, error: job.error });
  }
  job.runId = spawn.runId;
  job.state = 'running';
  emitJob(job, 'start', { runId: spawn.runId, startedAt: spawn.started });
  emitJob(job, 'running', {});

  // The row was INSERTed earlier (queued or running) at semaphore time.
  // Best-effort: a failure here only degrades the ISSUE-010 reload path.
  Promise.resolve().then(() => updateCodexJobStatus({
    jobId: job.id,
    status: 'running',
    lastEventTs: Date.now(),
    stdoutPath: path.join(spawn.workDir, 'stdout.log'),
    stderrPath: path.join(spawn.workDir, 'stderr.log'),
  })).catch(e => console.error('[codexJobs status update outer]', e.message));

  // respond 202 with the handles BEFORE we wait for the child
  json(res, 202, {
    ok: true, async: true, jobId: job.id, runId: spawn.runId,
    statusUrl: '/job/' + job.id,
    eventsUrl: '/job/' + job.id + '/events',
    timeoutSec: timeoutS,
    // ISSUE-014: surface the requested session id up-front so the client
    // can correlate this job with a prior one. The actual codexSessionId
    // (whether == requested for a successful resume, or a new one for a
    // fallback) arrives in the `codexSession` SSE event when the run ends.
    sessionId: spawn.sessionId || null,
    resumed: false,    // resolved in the codexSession event on close
  });

  const killTimer = setTimeout(() => {
    job.killed = true;
    try { process.kill(-spawn.child.pid, 'SIGKILL'); }
    catch (e) { try { spawn.child.kill('SIGKILL'); } catch {} }
  }, timeoutS * 1000);
  killTimer.unref();
  // T4 fix: stash the live child + kill timer on the job so
  // POST /job/:id/cancel (handleJobCancel) can reach them. Without this,
  // the cancel button is a 404.
  job.child = spawn.child;
  job.killTimer = killTimer;
  job.cancelRequested = false;

  // ISSUE-012: per-line, debounced tail stream. We split each chunk on \n,
  // keep the trailing partial in a buffer, and emit a batch of {lines: [...]}
  // at most every 100ms so the SSE channel doesn't get flooded. The
  // synchronous /run path is untouched and never emits these events.
  function makeLineTail(eventType) {
    let buf = '';
    let pending = [];
    let scheduled = null;
    const flush = () => {
      scheduled = null;
      if (!pending.length) return;
      const lines = pending;
      pending = [];
      emitJob(job, eventType, { lines });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = setTimeout(flush, 100);
    };
    return {
      push(chunkStr) {
        buf += chunkStr;
        let idx;
        const out = [];
        while ((idx = buf.indexOf('\n')) !== -1) {
          out.push(buf.slice(0, idx).replace(/\r$/, ''));
          buf = buf.slice(idx + 1);
        }
        if (out.length) {
          pending = pending.concat(out);
          schedule();
        }
      },
      // Force a final flush — used on child close so the trailing partial
      // line (no trailing newline) still reaches the UI.
      end() {
        if (buf.length) {
          pending = pending.concat([buf]);
          buf = '';
        }
        if (scheduled) { clearTimeout(scheduled); scheduled = null; }
        flush();
      },
    };
  }
  const stdoutTail = makeLineTail('codexStdout:line');
  const stderrTail = makeLineTail('codexStderr:line');

  let firstByteMs = null;
  spawn.child.stdout.on('data', c => {
    if (firstByteMs === null) {
      firstByteMs = Date.now() - spawn.started;
      job.spawnMs = firstByteMs;
      emitJob(job, 'firstByte', { spawnMs: firstByteMs });
    }
    const s = c.toString('utf8');
    job.stdout += s;
    job.stdoutBytes = job.stdout.length;
    stdoutTail.push(s);
  });
  spawn.child.stderr.on('data', c => {
    if (firstByteMs === null) {
      firstByteMs = Date.now() - spawn.started;
      job.spawnMs = firstByteMs;
      emitJob(job, 'firstByte', { spawnMs: firstByteMs });
    }
    const s = c.toString('utf8');
    job.stderr += s;
    job.stderrBytes = job.stderr.length;
    stderrTail.push(s);
  });

  spawn.child.on('close', (code) => {
    clearTimeout(killTimer);
    // ISSUE-012: drain any buffered tail lines so the UI sees the final
    // partial line of stdout / stderr.
    try { stdoutTail.end(); } catch {}
    try { stderrTail.end(); } catch {}
    const durationMs = Date.now() - spawn.started;
    job.finished = Date.now();
    job.durationMs = durationMs;
    job.gatewayMs = firstByteMs != null ? Math.max(0, durationMs - firstByteMs) : 0;
    job.quotaExceeded = /\b(429|too many requests|rate[_ -]?limit)\b/i.test(job.stderr + job.stdout);
    job.exitCode = code;
    // ISSUE-014: parse the codex thread id out of NDJSON stdout and
    // decide whether the resume actually succeeded. For a successful
    // resume of session X, codex re-emits thread.started with the same
    // id; for a failed resume (session not found / GC'd), we either get
    // no event or a different one. We treat a strict id match as
    // "resumed" — anything else (missing, new, mismatch) becomes a
    // fallback. Mirrors handleRun's logic.
    const codexSessionId = parseCodexSessionId(job.stdout + '\n' + job.stderr);
    const requestedSessionId = spawn.sessionId || null;
    const resumedOk = !!requestedSessionId && code === 0 && !!codexSessionId && codexSessionId === requestedSessionId;
    // ISSUE-014: stash resume outcome on the job for /job/:id status lookups.
    job.codexSessionId = codexSessionId || null;
    job.parentSessionId = requestedSessionId;
    job.resumed = resumedOk;
    job.fallbackReason = (requestedSessionId && !resumedOk) ? 'session_not_found' : null;
    try { fs.rmSync(spawn.workDir, { recursive: true, force: true }); } catch {}

    if (job.cancelRequested) {
      // T4 fix: user-initiated cancel (issue 002). Treat as a separate
      // terminal status from timeout so the UI can distinguish "user said
      // stop" from "we ran out of time". exitCode 130 mirrors the
      // conventional "killed by SIGINT/SIGTERM" signal-based exit.
      job.state = 'cancelled';
      job.ok = false;
      job.error = 'cancelled by user';
      job.exitCode = 130;
      emitJob(job, 'cancelled', { ok: false, exitCode: 130, durationMs, error: job.error,
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: false });
      emitJob(job, 'done', { ok: false, exitCode: 130, durationMs, error: job.error, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: false,
        ...(requestedSessionId ? { fallbackReason: 'session_not_found' } : {}) });
    } else if (job.killed) {
      job.state = 'error';
      job.ok = false;
      job.error = 'timeout';
      job.exitCode = 124;
      emitJob(job, 'done', { ok: false, exitCode: 124, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, error: job.error, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: false,
        ...(requestedSessionId ? { fallbackReason: 'session_not_found' } : {}) });
    } else if (code === 0) {
      job.state = 'done';
      job.ok = true;
      emitJob(job, 'done', { ok: true, exitCode: 0, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: resumedOk,
        ...(requestedSessionId && !resumedOk ? { fallbackReason: 'session_not_found' } : {}) });
    } else {
      job.state = 'error';
      job.ok = false;
      job.error = 'codex exit ' + code;
      emitJob(job, 'done', { ok: false, exitCode: code, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
        codexSessionId: codexSessionId || null, parentSessionId: requestedSessionId, resumed: false,
        ...(requestedSessionId ? { fallbackReason: 'session_not_found' } : {}) });
    }

    // ISSUE-014: surface resume outcome to the client via a dedicated SSE
    // event so the UI can show "continued / fallback / fresh" without
    // waiting for the next /job/:id poll.
    emitJob(job, 'codexSession', {
      codexSessionId: codexSessionId || null,
      parentSessionId: requestedSessionId,
      resumed: resumedOk,
      ...(requestedSessionId && !resumedOk ? { fallbackReason: 'session_not_found' } : {}),
    });

    // Terminal state → UPDATE codex_jobs (best-effort, log only on failure).
    // The 'timeout' / 'cancelled' enum values are reserved for the kill flow
    // (ISSUE-002/004/013). Here we map job.state ('done' | 'error') to the
    // RDS codex_jobs.status enum; the timeout case uses 'timeout' so the
    // /job/:id reload path can surface it correctly.
    const terminalStatus = job.cancelRequested ? 'cancelled' : (job.killed ? 'timeout' : job.state);
    Promise.resolve().then(() => updateCodexJobTerminal({
      jobId: job.id,
      status: terminalStatus,
      finishedAt: job.finished,
      durationMs: job.durationMs,
      exitCode: job.exitCode,
      lastEventTs: Date.now(),
    })).catch(e => console.error('[codexJobs update outer]', e.message));

    // fire-and-forget persistence (same shape as handleRun)
    Promise.resolve().then(() => recordRun({
      runId: spawn.runId, prompt, model: effectiveModel || null,
      exitCode: job.exitCode, durationMs,
      stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
      ok: !!job.ok, error: job.error || null,
      clientIp,
      codexSessionId: codexSessionId || null,
      parentSessionId: requestedSessionId,
    })).catch(e => console.error('[recordRun async]', e.message));
    // ISSUE-013: free the concurrency slot; this drains the queue and grants
    // the next FIFO waiter their slot (activeCount--, then drainQueue()).
    releaseSlot();
  });

  spawn.child.on('error', (e) => {
    clearTimeout(killTimer);
    job.state = 'error';
    job.ok = false;
    job.error = String(e && e.message || e);
    job.finished = Date.now();
    try { fs.rmSync(spawn.workDir, { recursive: true, force: true }); } catch {}
    emitJob(job, 'error', { error: job.error });
    // Best-effort: also update the codex_jobs row (status=error).
    Promise.resolve().then(() => updateCodexJobTerminal({
      jobId: job.id,
      status: 'error',
      finishedAt: job.finished,
      durationMs: job.durationMs ?? null,
      exitCode: job.exitCode ?? null,
      lastEventTs: Date.now(),
    })).catch(e => console.error('[codexJobs update outer]', e.message));
    // ISSUE-013: free the concurrency slot.
    releaseSlot();
  });
}

async function handleJobStatus(req, res, jobId) {
  const job = JOBS.get(jobId);
  if (job) {
    return json(res, 200, {
      ok: true, jobId: job.id, state: job.state, runId: job.runId,
      prompt: job.prompt, model: job.model, started: job.started, finished: job.finished,
      durationMs: job.durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs,
      quotaExceeded: job.quotaExceeded, exitCode: job.exitCode, ok: job.ok, error: job.error,
      stdoutPreview: (job.stdout || '').slice(-4000),
      stderrPreview: (job.stderr || '').slice(-2000),
      subscribers: job.subscribers,
      lastEvent: job.lastEvent || null,
      // ISSUE-014: surface the resume outcome so a polling client can
      // see `codexSessionId` / `resumed` / `fallbackReason` without
      // having to subscribe to the SSE channel.
      codexSessionId: job.codexSessionId || null,
      parentSessionId: job.parentSessionId || null,
      resumed: !!job.resumed,
      fallbackReason: job.fallbackReason || null,
    });
  }
  // Memory miss → fall through to RDS (ISSUE-010). This is what makes
  // /job/:id survive a process restart / 60-min Map GC.
  const rdsJob = await loadJobFromRds(jobId);
  if (!rdsJob) return json(res, 404, { ok: false, error: 'job not found or expired' });
  let stdoutTail = '', stderrTail = '';
  try {
    if (rdsJob.stdoutPath && fs.existsSync(rdsJob.stdoutPath)) stdoutTail = fs.readFileSync(rdsJob.stdoutPath, 'utf8').slice(-4000);
  } catch {}
  try {
    if (rdsJob.stderrPath && fs.existsSync(rdsJob.stderrPath)) stderrTail = fs.readFileSync(rdsJob.stderrPath, 'utf8').slice(-2000);
  } catch {}
  return json(res, 200, {
    ok: true, fromRds: true,
    jobId: rdsJob.id, state: rdsJob.state, runId: rdsJob.runId,
    prompt: rdsJob.prompt, model: rdsJob.model, started: rdsJob.started, finished: rdsJob.finished,
    durationMs: rdsJob.durationMs, spawnMs: rdsJob.spawnMs, gatewayMs: rdsJob.gatewayMs,
    quotaExceeded: rdsJob.quotaExceeded, exitCode: rdsJob.exitCode, ok: rdsJob.ok, error: rdsJob.error,
    stdoutPreview: stdoutTail,
    stderrPreview: stderrTail,
    subscribers: 0,
    lastEvent: rdsJob.lastEvent,
    stdoutPath: rdsJob.stdoutPath,
    stderrPath: rdsJob.stderrPath,
  });
}

// SSE: stream job events. The first event is always a 'snapshot' with the
// current state, so a late subscriber doesn't miss the start.
//
// Replay semantics (ISSUE-011): if the client passes ?resume=<evtId> (or the
// browser auto-sends Last-Event-ID), we replay every event with id > that
// one from the in-memory ring, then attach the live tail. EventSource in the
// browser can't set custom headers, so the frontend uses ?resume=<lastEventId>
// — both shapes are accepted.
//
// Memory miss → 404. Frontend falls back to one-shot /job/:id poll which
// T4 fix: POST /job/:id/cancel — issue 002's "异步卡片可取消" finally has
// a server-side endpoint. Looks up the live job in the in-memory Map
// (cancel against an already-GC'd / RDS-only job is 409, not 404 — the
// job exists, it's just terminal and can't be cancelled any more).
// Sends SIGTERM via killJobTree (issue 005); the child.on('close') path
// in startCodexJob will then promote the job to 'cancelled' and emit
// the SSE 'cancelled' event that 011 / 012 / 013 already listen for.
async function handleJobCancel(req, res, jobId) {
  const job = JOBS.get(jobId);
  if (!job) {
    // Memory miss → could be RDS-rebuilt (010) but the underlying codex
    // process is dead by definition if it's no longer in JOBS. 410 Gone
    // is the most truthful answer; the frontend treats 4xx uniformly as
    // "already terminal".
    return json(res, 410, { ok: false, error: 'job not in memory (already GCd or restarted)' });
  }
  if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled' || job.state === 'timeout') {
    return json(res, 409, { ok: false, error: 'job already terminal', state: job.state });
  }
  if (job.cancelRequested) {
    return json(res, 200, { ok: true, jobId, state: job.state, alreadyCanceling: true });
  }
  job.cancelRequested = true;
  if (job.killTimer) { try { clearTimeout(job.killTimer); } catch {} }
  const child = job.child || null;
  // Don't await — killJobTree is fire-and-forget here; the actual
  // state transition happens when the child's `close` event fires.
  killJobTree(child, { jobId, reason: 'user' })
    .then(r => console.log(`[cancel] job=${jobId} kill result=${JSON.stringify(r)}`))
    .catch(e => console.error(`[cancel] job=${jobId} kill error:`, e && e.message || e));
  return json(res, 200, { ok: true, jobId, state: job.state, cancelRequested: true });
}

// already walks RDS (ISSUE-010).
function handleJobEvents(req, res, jobId) {
  const url = new URL(req.url, 'http://x');
  const resumeId =
    (req.headers['last-event-id'] || '').toString().trim() ||
    (url.searchParams.get('resume') || '').toString().trim() ||
    null;

  const job = JOBS.get(jobId);
  if (!job) return json(res, 404, { ok: false, error: 'job not found or expired' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (type, data) => {
    try {
      // emit SSE `id:` field when payload carries one, so EventSource's
      // built-in auto-resume will also know what it last saw (we still
      // force ?resume= in the manual path because EventSource can't add
      // custom headers).
      const idLine = data && data.id ? ('id: ' + data.id + '\n') : '';
      res.write(idLine + 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch {}
  };

  // Replay from the requested cursor. If resumeId is unknown (typo, or
  // outside the ring), default to replay-everything so the client at least
  // converges to the current state.
  let replayFrom = 0;
  if (resumeId) {
    const idx = job.events.findIndex((e) => e.id === resumeId);
    if (idx >= 0) {
      replayFrom = idx + 1;          // skip the one they already saw
    } else {
      replayFrom = 0;                // unknown id → full replay
    }
  }

  // initial snapshot — always sent, even on resume, so the client has the
  // authoritative current state before any tail events
  write('snapshot', {
    id: 'snap-' + job.eventSeq,
    jobId: job.id, state: job.state, runId: job.runId,
    started: job.started, finished: job.finished,
    durationMs: job.durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs,
    quotaExceeded: job.quotaExceeded, exitCode: job.exitCode, ok: job.ok, error: job.error,
    resumed: !!resumeId,
  });

  for (let i = replayFrom; i < job.events.length; i++) {
    const e = job.events[i];
    write(e.type, e);
  }

  // If the job already finished before we attached, close after replay.
  if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
    try { res.end(); } catch {}
    return;
  }

  const onEvent = (evt) => write(evt.type, evt);
  job.emitter.on('event', onEvent);
  job.subscribers++;
  // keepalive ping every 25s
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  const cleanup = () => {
    clearInterval(ping);
    job.emitter.off('event', onEvent);
    job.subscribers = Math.max(0, job.subscribers - 1);
    try { res.end(); } catch {}
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-demo-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/healthz') {  // async
    let dbOk = null;
    if (pgPool) {
      try { await pgPool.query('SELECT 1'); dbOk = true; }
      catch (e) { dbOk = false; }
    }
    return json(res, 200, {
      ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT,
      authRequired: !!SHARED_SECRET,
      serverHasDefaultKey: !!SERVER_LLM_API_KEY,
      defaultModel: SERVER_LLM_DEFAULT_MODEL || null,
      db: pgPool ? { host: RDS_HOST, name: RDS_DB, ok: dbOk } : null,
      pdf: {
        skillDir: PDF_SKILL_DIR,
        script: PDF_SCRIPT,
        installed: fs.existsSync(PDF_SCRIPT),
        outputDir: PDF_OUTPUT_DIR,
      },
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1info') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(
      'codex-api online\n\n' +
      'POST /run   body={ prompt, apiKey, model?, timeoutSec? }\n' +
      'GET  /healthz\n\n' +
      'example:\n' +
      '  curl -sS http://HOST:3030/run \\\n' +
      "    -H 'content-type: application/json' \\\n" +
      "    -d '{\"prompt\":\"write hello world in python\",\"apiKey\":\"sk-...\"}'\n"
    );
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    if (!checkAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized (pass x-demo-key header or ?key=)' });
    if (!CODEX_AVAILABLE) return json(res, 503, { ok: false, error: 'codex binary or sandbox user not present on this host' });
    try { return await handleRun(req, res); }
    catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }
  if (req.method === 'POST' && url.pathname === '/run-async') {
    if (!checkAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized (pass x-demo-key header or ?key=)' });
    if (!CODEX_AVAILABLE) return json(res, 503, { ok: false, error: 'codex binary or sandbox user not present on this host' });
    try { return await handleRunAsync(req, res); }
    catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }
  // /job/:id  and  /job/:id/events  — async job state + SSE
  const jobMatch = url.pathname.match(/^\/job\/([0-9a-f-]{36})(?:\/events|\/cancel)?$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    if (req.method === 'POST' && url.pathname.endsWith('/cancel')) {
      return await handleJobCancel(req, res, jobId);
    }
    if (req.method === 'GET' && url.pathname.endsWith('/events')) return handleJobEvents(req, res, jobId);
    if (req.method === 'GET') return await handleJobStatus(req, res, jobId);
  }
  // ─── /pdf: URL or local path → PDF via md-to-pdf-webfirst skill ───
  if (req.method === 'POST' && (url.pathname === '/pdf' || url.pathname === '/pdf/from-url')) {
    try { return await handlePdfUrl(req, res); }
    catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }
  if (req.method === 'POST' && (url.pathname === '/pdf/upload' || url.pathname === '/pdf/from-file')) {
    try { return await handlePdfUpload(req, res); }
    catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }
  // ─── static frontend ───
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const candidates = [
      '/opt/codex-api/public/index.html',
      path.join(__dirname, '..', 'frontend', 'index.html'),
      path.join(process.cwd(), 'frontend', 'index.html'),
    ];
    for (const p of candidates) {
      try {
        const html = require('fs').readFileSync(p, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      } catch {}
    }
    return json(res, 500, { ok: false, error: 'frontend not found; tried: ' + candidates.join(', ') });
  }

  // ─── history ───
  if (req.method === 'GET' && url.pathname === '/history') {
    if (!pgPool) return json(res, 200, { ok: true, rows: [], note: 'no db configured' });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    try {
      const r = await pgPool.query(
        `SELECT run_id, prompt, model, exit_code, duration_ms, ok, created_at,
                LEFT(stdout, 800)  AS stdout_preview,
                LEFT(stderr, 400)  AS stderr_preview
           FROM codex_runs
           ORDER BY created_at DESC
           LIMIT $1`, [limit]
      );
      return json(res, 200, { ok: true, rows: r.rows });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
    if (!pgPool) return json(res, 404, { ok: false, error: 'no db' });
    const runId = url.pathname.slice('/history/'.length);
    try {
      const r = await pgPool.query(`SELECT * FROM codex_runs WHERE run_id = $1`, [runId]);
      if (!r.rows.length) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, row: r.rows[0] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[codex-api] listening on :${PORT}  user=${SANDBOX_USER}  authRequired=${!!SHARED_SECRET}`);
  // Pre-warm codex binary in the background so the first user request avoids
  // the 200-800ms Rust cold-start. Fires once, errors are non-fatal.
  try {
    const { spawn: _sp } = require('child_process');
    const w = _sp(CODEX_BIN, ['--version'], { stdio: 'ignore' });
    w.on('close', (code) => console.log(`[codex-api] pre-warm codex --version → exit ${code}`));
    w.on('error', (e) => console.log(`[codex-api] pre-warm skipped: ${e.message}`));
  } catch (e) { /* best effort */ }
});

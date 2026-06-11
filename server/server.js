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
      `INSERT INTO codex_runs(run_id, prompt, model, exit_code, duration_ms, stdout, stderr, ok, error, client_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.runId, row.prompt, row.model, row.exitCode ?? null,
       row.durationMs ?? null,
       (row.stdout || '').slice(0, 200000),
       (row.stderr || '').slice(0, 40000),
       !!row.ok,
       row.error || null,
       row.clientIp || null]
    );
  } catch (e) {
    console.error('[recordRun] insert failed:', e.message);
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

// ─── async /run: in-memory job store + per-job EventEmitter for SSE ───
const JOBS = new Map();              // jobId -> { state, emitter, ... }
const JOBS_TTL_MS = 60 * 60 * 1000;  // GC finished jobs after 1h

function newJobId() { return randomUUID(); }
function makeJob(initial) {
  const emitter = new (require('events'))();
  const job = { ...initial, emitter, subscribers: 0 };
  JOBS.set(job.id, job);
  return job;
}
function emitJob(job, type, payload) {
  const evt = { type, ts: Date.now(), ...payload };
  job.lastEvent = evt;
  job.emitter.emit('event', evt);
}
function gcJob(job) {
  setTimeout(() => { if (JOBS.get(job.id) === job) JOBS.delete(job.id); }, JOBS_TTL_MS).unref();
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
// Returns { child, runId, workDir, started, firstBytePromise }.
function startCodexJob({ prompt, effectiveKey, effectiveModel, timeoutS, clientIp }) {
  const runId = randomUUID();
  const workDir = path.join(RUN_BASE, runId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o770 });
  try {
    const { execSync } = require('child_process');
    execSync(`chown ${SANDBOX_USER}:${SANDBOX_USER} ${workDir}`);
  } catch {}

  const codexArgs = [
    'exec',
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
  codexArgs.push(prompt);

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
  return { child, runId, workDir, started };
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
  const timeoutS  = Math.min(parseInt(body.timeoutSec || DEFAULT_TIMEOUT, 10) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
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
  codexArgs.push(prompt);

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
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

    let payload, status;
    if (killed) {
      status = 504;
      payload = { ok: false, error: `timed out after ${timeoutS}s`, runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    } else if (code === 0) {
      status = 200;
      payload = { ok: true, exitCode: code, runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    } else {
      status = 502;
      payload = { ok: false, exitCode: code, runId, durationMs, spawnMs, gatewayMs, quotaExceeded, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    }
    json(res, status, payload);

    // fire-and-forget persistence
    Promise.resolve().then(() => recordRun({
      runId, prompt, model: effectiveModel || null,
      exitCode: payload.exitCode ?? null,
      durationMs, stdout: payload.stdout, stderr: payload.stderr,
      ok: !!payload.ok, error: payload.error || null,
      clientIp,
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
  const timeoutS  = Math.min(parseInt(body.timeoutSec || MAX_TIMEOUT, 10) || MAX_TIMEOUT, MAX_TIMEOUT);
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

  let spawn;
  try {
    spawn = startCodexJob({ prompt, effectiveKey, effectiveModel, timeoutS, clientIp });
  } catch (e) {
    job.state = 'error';
    job.error = String(e && e.message || e);
    job.finished = Date.now();
    emitJob(job, 'error', { error: job.error });
    return json(res, 500, { ok: false, jobId: job.id, error: job.error });
  }
  job.runId = spawn.runId;
  job.state = 'running';
  emitJob(job, 'start', { runId: spawn.runId, startedAt: spawn.started });
  emitJob(job, 'running', {});

  // respond 202 with the handles BEFORE we wait for the child
  json(res, 202, {
    ok: true, async: true, jobId: job.id, runId: spawn.runId,
    statusUrl: '/job/' + job.id,
    eventsUrl: '/job/' + job.id + '/events',
    timeoutSec: timeoutS,
  });

  const killTimer = setTimeout(() => {
    job.killed = true;
    try { process.kill(-spawn.child.pid, 'SIGKILL'); }
    catch (e) { try { spawn.child.kill('SIGKILL'); } catch {} }
  }, timeoutS * 1000);
  killTimer.unref();

  let firstByteMs = null;
  spawn.child.stdout.on('data', c => {
    if (firstByteMs === null) {
      firstByteMs = Date.now() - spawn.started;
      job.spawnMs = firstByteMs;
      emitJob(job, 'firstByte', { spawnMs: firstByteMs });
    }
    job.stdout += c.toString('utf8');
    job.stdoutBytes = job.stdout.length;
  });
  spawn.child.stderr.on('data', c => {
    if (firstByteMs === null) {
      firstByteMs = Date.now() - spawn.started;
      job.spawnMs = firstByteMs;
      emitJob(job, 'firstByte', { spawnMs: firstByteMs });
    }
    job.stderr += c.toString('utf8');
    job.stderrBytes = job.stderr.length;
  });

  spawn.child.on('close', (code) => {
    clearTimeout(killTimer);
    const durationMs = Date.now() - spawn.started;
    job.finished = Date.now();
    job.durationMs = durationMs;
    job.gatewayMs = firstByteMs != null ? Math.max(0, durationMs - firstByteMs) : 0;
    job.quotaExceeded = /\b(429|too many requests|rate[_ -]?limit)\b/i.test(job.stderr + job.stdout);
    job.exitCode = code;
    try { fs.rmSync(spawn.workDir, { recursive: true, force: true }); } catch {}

    if (job.killed) {
      job.state = 'error';
      job.ok = false;
      job.error = 'timed out after ' + timeoutS + 's';
      emitJob(job, 'done', { ok: false, exitCode: null, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, error: job.error, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192) });
    } else if (code === 0) {
      job.state = 'done';
      job.ok = true;
      emitJob(job, 'done', { ok: true, exitCode: 0, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192) });
    } else {
      job.state = 'error';
      job.ok = false;
      job.error = 'codex exit ' + code;
      emitJob(job, 'done', { ok: false, exitCode: code, durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs, quotaExceeded: job.quotaExceeded, stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192) });
    }

    // fire-and-forget persistence (same shape as handleRun)
    Promise.resolve().then(() => recordRun({
      runId: spawn.runId, prompt, model: effectiveModel || null,
      exitCode: job.exitCode, durationMs,
      stdout: job.stdout.slice(-65536), stderr: job.stderr.slice(-8192),
      ok: !!job.ok, error: job.error || null,
      clientIp,
    })).catch(e => console.error('[recordRun async]', e.message));
  });

  spawn.child.on('error', (e) => {
    clearTimeout(killTimer);
    job.state = 'error';
    job.ok = false;
    job.error = String(e && e.message || e);
    job.finished = Date.now();
    try { fs.rmSync(spawn.workDir, { recursive: true, force: true }); } catch {}
    emitJob(job, 'error', { error: job.error });
  });
}

function handleJobStatus(req, res, jobId) {
  const job = JOBS.get(jobId);
  if (!job) return json(res, 404, { ok: false, error: 'job not found or expired' });
  json(res, 200, {
    ok: true, jobId: job.id, state: job.state, runId: job.runId,
    prompt: job.prompt, model: job.model, started: job.started, finished: job.finished,
    durationMs: job.durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs,
    quotaExceeded: job.quotaExceeded, exitCode: job.exitCode, ok: job.ok, error: job.error,
    stdoutPreview: (job.stdout || '').slice(-4000),
    stderrPreview: (job.stderr || '').slice(-2000),
    subscribers: job.subscribers,
    lastEvent: job.lastEvent || null,
  });
}

// SSE: stream job events. The first event is always a 'snapshot' with the
// current state, so a late subscriber doesn't miss the start.
function handleJobEvents(req, res, jobId) {
  const job = JOBS.get(jobId);
  if (!job) return json(res, 404, { ok: false, error: 'job not found or expired' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (type, data) => {
    try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch {}
  };
  // initial snapshot
  write('snapshot', {
    jobId: job.id, state: job.state, runId: job.runId,
    started: job.started, finished: job.finished,
    durationMs: job.durationMs, spawnMs: job.spawnMs, gatewayMs: job.gatewayMs,
    quotaExceeded: job.quotaExceeded, exitCode: job.exitCode, ok: job.ok, error: job.error,
  });
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
  const jobMatch = url.pathname.match(/^\/job\/([0-9a-f-]{36})(?:\/events)?$/);
  if (req.method === 'GET' && jobMatch) {
    const jobId = jobMatch[1];
    if (url.pathname.endsWith('/events')) return handleJobEvents(req, res, jobId);
    return handleJobStatus(req, res, jobId);
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

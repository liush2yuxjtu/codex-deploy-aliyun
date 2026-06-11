#!/bin/bash
set -e

echo "=== 0. kill any zombie docker builds + clean wasted layers ==="
pkill -f 'docker build' 2>/dev/null || true
docker builder prune -f 2>&1 | tail -3 || true

echo ""
echo "=== 1. create codexsbx user for sandbox (system UID, auto-pick) ==="
if ! id codexsbx >/dev/null 2>&1; then
  useradd -r -m -d /home/codexsbx -s /sbin/nologin codexsbx
fi
id codexsbx
mkdir -p /var/lib/codex-runs
chown root:codexsbx /var/lib/codex-runs
chmod 770 /var/lib/codex-runs

echo ""
echo "=== 2. test codex as codexsbx (sanity) ==="
runuser -u codexsbx -- /opt/node-v20.18.1-linux-x64/bin/codex --version || true

echo ""
echo "=== 3. write the demo HTTP API (Node, native codex, port 3030) ==="
mkdir -p /opt/codex-api
cat > /opt/codex-api/server.js <<'JS'
// codex-api: thin HTTP wrapper that runs `codex exec` as the codexsbx user
// inside a fresh per-request tmpdir, with codex's built-in sandbox enabled.
//
// POST /run  body: { prompt, apiKey, model?, timeoutSec? }
//   -> 200 { ok, exitCode, runId, durationMs, stdout, stderr }
// GET  /healthz, GET /
const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT          = parseInt(process.env.PORT || '3030', 10);
const SHARED_SECRET = process.env.DEMO_SECRET || ''; // empty = no auth
const CODEX_BIN     = '/opt/node-v20.18.1-linux-x64/bin/codex';
const SANDBOX_USER  = 'codexsbx';
const RUN_BASE      = '/var/lib/codex-runs';
const DEFAULT_TIMEOUT = 90;
const MAX_TIMEOUT     = 240;

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

async function handleRun(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
  const prompt    = (body.prompt || '').toString();
  const apiKey    = (body.apiKey || body.openaiApiKey || '').toString();
  const model     = (body.model  || '').toString();
  const timeoutS  = Math.min(parseInt(body.timeoutSec || DEFAULT_TIMEOUT, 10) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
  if (!prompt) return json(res, 400, { ok: false, error: 'missing prompt' });
  if (!apiKey) return json(res, 400, { ok: false, error: 'missing apiKey (pass body.apiKey = your sk-... key)' });

  const runId = randomUUID();
  const workDir = path.join(RUN_BASE, runId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o770 });
  // chown to codexsbx so the user can write inside
  try {
    const { execSync } = require('child_process');
    execSync(`chown ${SANDBOX_USER}:${SANDBOX_USER} ${workDir}`);
  } catch (e) { /* best-effort */ }

  // Build the codex command
  // -s workspace-write   → codex's built-in sandbox: writes restricted to -C dir
  // -c approval_policy="never"  → never prompt for approval (yolo-equivalent)
  // --skip-git-repo-check       → /work is not a git repo
  // --ephemeral                 → don't persist session under ~/.codex
  // --color never               → clean output for HTTP
  // -C <dir>                    → workspace root
  const codexArgs = [
    'exec',
    '-s', 'workspace-write',
    '-c', 'approval_policy="never"',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '-C', workDir,
  ];
  if (model) codexArgs.push('-m', model);
  codexArgs.push(prompt);

  // wrap with runuser to drop privileges to codexsbx
  const argv = ['-u', SANDBOX_USER, '--', CODEX_BIN, ...codexArgs];

  const started = Date.now();
  const child = spawn('runuser', argv, {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: `/home/${SANDBOX_USER}`,
      USER: SANDBOX_USER,
      OPENAI_API_KEY: apiKey,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });
  let stdout = '', stderr = '', killed = false;
  child.stdout.on('data', c => stdout += c.toString('utf8'));
  child.stderr.on('data', c => stderr += c.toString('utf8'));

  const killTimer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutS * 1000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    const durationMs = Date.now() - started;
    // cleanup workdir (best-effort)
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    if (killed) {
      return json(res, 504, { ok: false, error: `timed out after ${timeoutS}s`, runId, durationMs, stdout, stderr });
    }
    json(res, code === 0 ? 200 : 502, {
      ok: code === 0,
      exitCode: code,
      runId,
      durationMs,
      stdout: stdout.slice(-65536),
      stderr: stderr.slice(-8192),
    });
  });

  child.on('error', (e) => {
    clearTimeout(killTimer);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    json(res, 500, { ok: false, error: String(e && e.message || e) });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-demo-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT, authRequired: !!SHARED_SECRET });
  }
  if (req.method === 'GET' && url.pathname === '/') {
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
    try { return await handleRun(req, res); }
    catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }
  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[codex-api] listening on :${PORT}  user=${SANDBOX_USER}  authRequired=${!!SHARED_SECRET}`);
});
JS
echo "wrote /opt/codex-api/server.js ($(wc -l < /opt/codex-api/server.js) lines)"

echo ""
echo "=== 4. systemd unit ==="
cat > /etc/systemd/system/codex-api.service <<'UNIT'
[Unit]
Description=codex-api demo (HTTP wrapper around codex exec, sandboxed via codex -s workspace-write + dropped to codexsbx user)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/codex-api
ExecStart=/opt/node-v20.18.1-linux-x64/bin/node /opt/codex-api/server.js
Restart=always
RestartSec=2
Environment=PORT=3030
StandardOutput=journal
StandardError=journal
KillMode=mixed
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable codex-api.service 2>&1
systemctl restart codex-api.service
sleep 2

echo ""
echo "=== 5. status ==="
systemctl is-active codex-api.service
systemctl status codex-api.service --no-pager | head -15
echo ""
echo "--- last 10 lines journal ---"
journalctl -u codex-api.service -n 10 --no-pager

echo ""
echo "=== 6. local smoke test ==="
curl -sS http://127.0.0.1:3030/healthz
echo ""
curl -sS http://127.0.0.1:3030/

echo ""
echo "=== 7. attempt a real codex exec with bogus key (proves wiring works, expect auth error from openai) ==="
curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 60 \
  -d '{"prompt":"say hi in one word","apiKey":"sk-test-invalid-key-for-wiring-check","timeoutSec":30}' | head -c 2000
echo ""

echo ""
echo "=== DONE step C-v2 ==="

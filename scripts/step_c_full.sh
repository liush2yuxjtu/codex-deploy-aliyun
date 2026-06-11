#!/bin/bash
set -e

echo "=== 1. write Dockerfile (UID 1001) ==="
mkdir -p /opt/codex-api/sandbox
cat > /opt/codex-api/sandbox/Dockerfile <<'DOCKERFILE'
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && npm config set registry https://registry.npmmirror.com \
 && npm install -g @openai/codex \
 && useradd -m -u 1001 codexsbx \
 && mkdir -p /work \
 && chown codexsbx:codexsbx /work

USER codexsbx
WORKDIR /work
ENV TERM=dumb \
    HOME=/home/codexsbx
ENTRYPOINT ["dumb-init","--","codex"]
DOCKERFILE

echo ""
echo "=== 2. build codex-sandbox:latest ==="
cd /opt/codex-api/sandbox
docker build -t codex-sandbox:latest . 2>&1 | tail -10

echo ""
echo "=== 3. verify image + run smoke test ==="
docker images codex-sandbox
docker run --rm codex-sandbox:latest exec --help 2>&1 | grep -E '(--yolo|--dangerously|--skip-git|workspace-write)' | head -10

echo ""
echo "=== 4. write the demo HTTP API (Node, no deps, port 3030) ==="
mkdir -p /opt/codex-api
cat > /opt/codex-api/server.js <<'JS'
// codex-api: thin HTTP wrapper around `docker run codex-sandbox codex exec ...`
// POST /run  body: { prompt: string, apiKey: string, timeoutSec?: number, model?: string }
//   -> { ok, exitCode, stdout, stderr, durationMs }
// GET  /healthz -> { ok: true, image: '<sha>' }
const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT          = parseInt(process.env.PORT || '3030', 10);
const SHARED_SECRET = process.env.DEMO_SECRET || ''; // empty = no auth (set via systemd)
const DEFAULT_TIMEOUT = 90;  // seconds
const MAX_TIMEOUT     = 240;
const IMAGE = 'codex-sandbox:latest';

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
  const headerKey = req.headers['x-demo-key'] || '';
  const queryKey  = url.searchParams.get('key') || '';
  return headerKey === SHARED_SECRET || queryKey === SHARED_SECRET;
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
  const dockerArgs = [
    'run', '--rm', '-i',
    '--name', `codex-run-${runId}`,
    '--memory=1g', '--cpus=1.0', '--pids-limit=128',
    '--network=bridge',
    '-e', 'OPENAI_API_KEY',
    'codex-sandbox:latest',
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--color', 'never',
  ];
  if (model) dockerArgs.push('-m', model);
  dockerArgs.push(prompt);

  const started = Date.now();
  const child = spawn('docker', dockerArgs, {
    env: { ...process.env, OPENAI_API_KEY: apiKey },
  });
  let stdout = '', stderr = '', killed = false;
  child.stdout.on('data', c => stdout += c.toString('utf8'));
  child.stderr.on('data', c => stderr += c.toString('utf8'));

  const killTimer = setTimeout(() => {
    killed = true;
    spawn('docker', ['kill', `codex-run-${runId}`]);
  }, timeoutS * 1000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    const durationMs = Date.now() - started;
    if (killed) {
      return json(res, 504, { ok: false, error: `timed out after ${timeoutS}s`, durationMs, stdout, stderr });
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
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-demo-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, image: IMAGE, port: PORT, authRequired: !!SHARED_SECRET });
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(
      'codex-api online.\n\n' +
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
  console.log(`[codex-api] listening on :${PORT}  image=${IMAGE}  authRequired=${!!SHARED_SECRET}`);
});
JS

echo "wrote /opt/codex-api/server.js  ($(wc -l < /opt/codex-api/server.js) lines)"

echo ""
echo "=== 5. systemd unit ==="
cat > /etc/systemd/system/codex-api.service <<'UNIT'
[Unit]
Description=codex-api demo (HTTP wrapper around docker codex-sandbox)
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/codex-api
ExecStart=/opt/node-v20.18.1-linux-x64/bin/node /opt/codex-api/server.js
Restart=always
RestartSec=2
Environment=PORT=3030
# leave DEMO_SECRET unset for now — we'll add it via override after first verify
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable codex-api.service
systemctl restart codex-api.service
sleep 2
systemctl status codex-api.service --no-pager | head -15

echo ""
echo "=== 6. local smoke test (curl localhost) ==="
curl -sS http://127.0.0.1:3030/healthz
echo ""
curl -sS http://127.0.0.1:3030/

echo ""
echo "=== DONE step C ==="

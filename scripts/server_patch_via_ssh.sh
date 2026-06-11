#!/bin/bash
set -e

echo "=== 1. patch server.js: ignore stdin + serve static frontend ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# --- A. stdio: ignore stdin so codex doesn't hang reading from pipe ---
old_block = """const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    detached: true,
    env: {"""
new_block = """const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {"""
if old_block in src:
    src = src.replace(old_block, new_block, 1)
    print('A: stdio patched')
elif "stdio: ['ignore', 'pipe', 'pipe']" in src:
    print('A: stdio already patched')
else:
    raise SystemExit('A pattern not found')

# --- B. static frontend serving ---
old_404 = """  json(res, 404, { ok: false, error: 'not found' });
});"""
new_404 = """  // ─── static frontend ───
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = require('fs').readFileSync('/opt/codex-api/public/index.html', 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    } catch (e) {
      return json(res, 500, { ok: false, error: 'frontend not deployed: ' + e.message });
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
});"""
if 'frontend not deployed' in src:
    print('B: static already patched')
else:
    assert old_404 in src, 'B fallback not found'
    src = src.replace(old_404, new_404, 1)
    print('B: static patched')

# --- C. retire the plain-text GET /, expose at /v1info instead ---
plain = """  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });"""
if plain in src:
    src = src.replace("url.pathname === '/'", "url.pathname === '/v1info'", 1)
    print('C: plain-doc moved to /v1info')

p.write_text(src)
print('len=', len(src))
PY

echo ""
echo "=== 2. restart + verify ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
journalctl -u codex-api.service -n 5 --no-pager

echo ""
echo "=== 3. local smoke tests ==="
echo "--- GET /healthz ---"
curl -sS http://127.0.0.1:3030/healthz; echo
echo "--- GET / (head) ---"
curl -sS http://127.0.0.1:3030/ | head -5
echo "--- POST /run bogus key, timeoutSec 15 ---"
time curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 25 \
  -d '{"prompt":"say hi","apiKey":"sk-test-invalid","timeoutSec":15}' | head -c 2000
echo

echo ""
echo "=== 4. orphan check ==="
sleep 2
ps -eo pid,user,etimes,cmd | grep -E 'codex' | grep -v grep | grep -v 'server.js' || echo "(no codex orphans — clean!)"

echo ""
echo "=== DONE ==="

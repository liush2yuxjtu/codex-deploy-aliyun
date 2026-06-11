#!/bin/bash
# Final deploy: stdin fix + static serve + default key/baseURL + codex provider config
set -e

# Load secrets from repo .env (Mac dev) or /etc/codex-api/secret.env (SWAS)
SECRETS_FILE="${SECRETS_FILE:-$(dirname "$0")/../.env}"
[ -f "$SECRETS_FILE" ] && { set -a; . "$SECRETS_FILE"; set +a; }
[ -z "$LLM_API_KEY" ] && [ -f /etc/codex-api/secret.env ] && . /etc/codex-api/secret.env
: "${LLM_API_KEY:?LLM_API_KEY not set — need $SECRETS_FILE or /etc/codex-api/secret.env}"

echo "=== 1. patch server.js (stdio ignore + static serve + default-key fallback) ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
s = p.read_text()

# A. stdio ignore stdin
old = """    detached: true,
    env: {"""
new = """    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {"""
if "stdio: ['ignore', 'pipe', 'pipe']" not in s:
  assert old in s
  s = s.replace(old, new, 1)
  print('A patched (stdio)')
else:
  print('A skipped (already patched)')

# B. default-key fallback — apiKey body param falls back to env DEFAULT_OPENAI_API_KEY
old2 = """const apiKey    = (body.apiKey || body.openaiApiKey || '').toString();"""
new2 = """const apiKey    = (body.apiKey || body.openaiApiKey || process.env.DEFAULT_OPENAI_API_KEY || '').toString();"""
if old2 in s:
  s = s.replace(old2, new2, 1)
  print('B patched (apiKey fallback)')

# B2. default model from env
old3 = """const model     = (body.model  || '').toString();"""
new3 = """const model     = (body.model  || process.env.DEFAULT_MODEL || '').toString();"""
if old3 in s:
  s = s.replace(old3, new3, 1)
  print('B2 patched (model fallback)')

# C. healthz exposes hasDefaultKey so frontend can skip modal
old4 = """return json(res, 200, { ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT, authRequired: !!SHARED_SECRET });"""
new4 = """return json(res, 200, { ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT, authRequired: !!SHARED_SECRET, hasDefaultKey: !!process.env.DEFAULT_OPENAI_API_KEY, defaultModel: process.env.DEFAULT_MODEL || null });"""
if old4 in s:
  s = s.replace(old4, new4, 1)
  print('C patched (healthz expose)')

# D. static frontend
old5 = """  json(res, 404, { ok: false, error: 'not found' });
});"""
new5 = """  // ─── static frontend ───
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
if 'frontend not deployed' not in s:
  assert old5 in s
  s = s.replace(old5, new5, 1)
  print('D patched (static)')

# E. retire plain GET / → /v1info (only if not yet done)
plain_old = """  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });"""
if plain_old in s:
  s = s.replace("url.pathname === '/'", "url.pathname === '/v1info'", 1)
  print('E patched (plain → /v1info)')

p.write_text(s)
print('len=', len(s))
PY

echo ""
echo "=== 2. write codex config.toml for codexsbx (gateway: code.newcli.com, wire=chat) ==="
mkdir -p /home/codexsbx/.codex
cat > /home/codexsbx/.codex/config.toml <<'TOML'
model = "gpt-5.5"
model_provider = "newcli"
approval_policy = "never"

[model_providers.newcli]
name = "newcli"
base_url = "https://code.newcli.com/codex/v1"
wire_api = "chat"
env_key = "OPENAI_API_KEY"
TOML
chown -R codexsbx:codexsbx /home/codexsbx/.codex
chmod 700 /home/codexsbx/.codex
chmod 600 /home/codexsbx/.codex/config.toml
echo "--- config.toml ---"
cat /home/codexsbx/.codex/config.toml

echo ""
echo "=== 3. systemd override: inject DEFAULT_OPENAI_API_KEY + DEFAULT_MODEL ==="
mkdir -p /etc/systemd/system/codex-api.service.d
cat > /etc/systemd/system/codex-api.service.d/env.conf <<UNIT
[Service]
Environment=DEFAULT_OPENAI_API_KEY=${LLM_API_KEY}
Environment=DEFAULT_MODEL=gpt-5.5
UNIT
chmod 600 /etc/systemd/system/codex-api.service.d/env.conf
systemctl daemon-reload
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
echo ""
echo "--- service env (sanitized) ---"
systemctl show codex-api.service -p Environment | sed 's/sk-ant-[^ ]*/sk-ant-***REDACTED***/'

echo ""
echo "=== 4. smoke test /healthz (should show hasDefaultKey:true) ==="
curl -sS http://127.0.0.1:3030/healthz; echo

echo ""
echo "=== 5. smoke test POST /run WITHOUT key in body (uses server default) ==="
echo "--- prompt: 'say hi in 3 words' ---"
time curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 90 \
  -d '{"prompt":"say hi in 3 words","timeoutSec":60}' | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('ok:', d.get('ok'))
print('exit:', d.get('exitCode'))
print('duration_ms:', d.get('durationMs'))
print('runId:', d.get('runId'))
print('--- stdout ---')
print(d.get('stdout','')[:2500])
print('--- stderr ---')
print(d.get('stderr','')[:1500])
"

echo ""
echo "=== 6. orphan check ==="
sleep 2
ps -eo pid,user,etimes,cmd | grep codex | grep -v grep | grep -v 'server.js' || echo "(no orphans — clean)"

echo ""
echo "=== 7. firewall confirm ==="
ss -tlnp | grep ':3030 '

echo ""
echo "=== DONE final deploy ==="

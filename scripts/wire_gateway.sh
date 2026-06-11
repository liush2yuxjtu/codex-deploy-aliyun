#!/bin/bash
set -e

# Load secrets from repo .env (Mac dev) or /etc/codex-api/secret.env (SWAS)
SECRETS_FILE="${SECRETS_FILE:-$(dirname "$0")/../.env}"
[ -f "$SECRETS_FILE" ] && { set -a; . "$SECRETS_FILE"; set +a; }
[ -z "$LLM_API_KEY" ] && [ -f /etc/codex-api/secret.env ] && . /etc/codex-api/secret.env
: "${LLM_API_KEY:?LLM_API_KEY not set — need $SECRETS_FILE or /etc/codex-api/secret.env}"
: "${LLM_BASE_URL:?LLM_BASE_URL not set}"
LLM_MODEL="${LLM_DEFAULT_MODEL:?LLM_DEFAULT_MODEL not set}"

echo "=== 1. write codex config.toml for codexsbx ==="
mkdir -p /home/codexsbx/.codex
cat > /home/codexsbx/.codex/config.toml <<TOML
# routes Codex CLI requests through the in-house gateway (OpenAI-compatible)
model = "${LLM_MODEL}"
model_provider = "newcli"
disable_response_storage = true

[model_providers.newcli]
name = "NewCLI Codex Gateway"
base_url = "${LLM_BASE_URL}"
wire_api = "responses"
env_key = "LLM_API_KEY"
request_max_retries = 1
stream_max_retries = 1
TOML
chown -R codexsbx:codexsbx /home/codexsbx/.codex
chmod 700 /home/codexsbx/.codex
ls -la /home/codexsbx/.codex/
echo "--- config.toml ---"
cat /home/codexsbx/.codex/config.toml

echo ""
echo "=== 2. store server-side API key in /etc/codex-api/secret.env (root only) ==="
mkdir -p /etc/codex-api
cat > /etc/codex-api/secret.env <<EOF
LLM_API_KEY=${LLM_API_KEY}
LLM_BASE_URL=${LLM_BASE_URL}
LLM_DEFAULT_MODEL=${LLM_MODEL}
EOF
chmod 600 /etc/codex-api/secret.env
chown root:root /etc/codex-api/secret.env
ls -la /etc/codex-api/secret.env

echo ""
echo "=== 3. patch server.js: load secret.env, allow no-apiKey, pass LLM_API_KEY ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# --- A. Add secret loader at top (after PORT/SHARED_SECRET) ---
header_anchor = "const SHARED_SECRET = process.env.DEMO_SECRET || ''; // empty = no auth"
if 'SECRET_FILE' not in src:
    addon = """
const SECRET_FILE = '/etc/codex-api/secret.env';
let SERVER_LLM_API_KEY = '';
let SERVER_LLM_DEFAULT_MODEL = '';
try {
  const txt = require('fs').readFileSync(SECRET_FILE, 'utf8');
  for (const line of txt.split('\\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'LLM_API_KEY') SERVER_LLM_API_KEY = m[2].trim();
    if (m[1] === 'LLM_DEFAULT_MODEL') SERVER_LLM_DEFAULT_MODEL = m[2].trim();
  }
  console.log('[codex-api] loaded server LLM key (' + SERVER_LLM_API_KEY.slice(0,12) + '…) default model=' + SERVER_LLM_DEFAULT_MODEL);
} catch (e) {
  console.log('[codex-api] no secret file at', SECRET_FILE, '— requests must supply apiKey');
}"""
    src = src.replace(header_anchor, header_anchor + addon, 1)

# --- B. handleRun: relax apiKey requirement, use SERVER_LLM_API_KEY fallback ---
old_check = """  if (!prompt) return json(res, 400, { ok: false, error: 'missing prompt' });
  if (!apiKey) return json(res, 400, { ok: false, error: 'missing apiKey (pass body.apiKey = your sk-... key)' });"""
new_check = """  if (!prompt) return json(res, 400, { ok: false, error: 'missing prompt' });
  const effectiveKey = apiKey || SERVER_LLM_API_KEY;
  if (!effectiveKey) return json(res, 400, { ok: false, error: 'missing apiKey: neither request body nor server has one' });
  const effectiveModel = model || SERVER_LLM_DEFAULT_MODEL || '';"""
if old_check in src:
    src = src.replace(old_check, new_check, 1)

# --- C. Spawn env: pass LLM_API_KEY (gateway expects it) instead of OPENAI_API_KEY ---
old_env = """      OPENAI_API_KEY: apiKey,"""
new_env = """      LLM_API_KEY: effectiveKey,
      OPENAI_API_KEY: effectiveKey,"""
if old_env in src:
    src = src.replace(old_env, new_env, 1)

# --- D. effectiveModel vs model — replace remaining `model` ref ---
old_model_ref = """  if (model) codexArgs.push('-m', model);"""
new_model_ref = """  if (effectiveModel) codexArgs.push('-m', effectiveModel);"""
if old_model_ref in src:
    src = src.replace(old_model_ref, new_model_ref, 1)

# --- E. healthz: also report whether server has a default key ---
old_hz = """    return json(res, 200, { ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT, authRequired: !!SHARED_SECRET });"""
new_hz = """    return json(res, 200, {
      ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT,
      authRequired: !!SHARED_SECRET,
      serverHasDefaultKey: !!SERVER_LLM_API_KEY,
      defaultModel: SERVER_LLM_DEFAULT_MODEL || null,
    });"""
if old_hz in src:
    src = src.replace(old_hz, new_hz, 1)

p.write_text(src)
print('patched, len=', len(src))
PY

echo ""
echo "=== 4. restart ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
journalctl -u codex-api.service -n 5 --no-pager

echo ""
echo "=== 5. /healthz (should now show serverHasDefaultKey=true) ==="
curl -sS http://127.0.0.1:3030/healthz; echo

echo ""
echo "=== 6. REAL smoke test — empty apiKey, server uses its default ==="
echo "(this will actually call the gateway → real model response)"
time curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 90 \
  -d '{"prompt":"reply with exactly the three words: codex sandbox alive","timeoutSec":75}' | head -c 4000
echo

echo ""
echo "=== 7. orphan check ==="
sleep 1
ps -eo pid,user,etimes,cmd | grep -E 'codex' | grep -v grep | grep -v 'server.js' || echo "(no orphans)"

echo ""
echo "=== DONE ==="

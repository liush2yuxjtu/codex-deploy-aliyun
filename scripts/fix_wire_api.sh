#!/bin/bash
set -e
echo "=== fix codex config: wire_api=responses, model=gpt-5.4-fast ==="
cat > /home/codexsbx/.codex/config.toml <<'TOML'
model = "gpt-5.4-fast"
model_provider = "newcli"
approval_policy = "never"

[model_providers.newcli]
name = "newcli"
base_url = "https://code.newcli.com/codex/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
TOML
chown -R codexsbx:codexsbx /home/codexsbx/.codex
cat /home/codexsbx/.codex/config.toml

echo ""
echo "=== update systemd DEFAULT_MODEL to gpt-5.4-fast too ==="
sed -i 's|DEFAULT_MODEL=[^"]*|DEFAULT_MODEL=gpt-5.4-fast|' /etc/systemd/system/codex-api.service.d/env.conf
systemctl daemon-reload
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service

echo ""
echo "=== /healthz ==="
curl -sS http://127.0.0.1:3030/healthz; echo

echo ""
echo "=== POST /run no body key (uses default), gpt-5.4-fast, 90s timeout ==="
time curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 100 \
  -d '{"prompt":"say hi in 3 words","timeoutSec":75}' | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('ok:', d.get('ok'))
print('exit:', d.get('exitCode'))
print('durationMs:', d.get('durationMs'))
print('runId:', d.get('runId'))
print('--- stdout (last 3500) ---')
print((d.get('stdout','') or '')[-3500:])
print('--- stderr (last 1500) ---')
print((d.get('stderr','') or '')[-1500:])
"

echo ""
echo "=== orphan check ==="
ps -eo pid,user,etimes,cmd | grep codex | grep -v grep | grep -v 'server.js' || echo "(no orphans)"

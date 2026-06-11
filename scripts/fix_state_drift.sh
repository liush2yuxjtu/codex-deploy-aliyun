#!/bin/bash
set -e

echo "=== 1. patch server.js: use --ignore-user-config + -c overrides ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# replace the codexArgs construction with the fully-overridden version
old = """  // Build the codex command
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
  ];"""
new = """  // Build the codex command. Every config injected per-call via -c so no
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
  ];"""
assert old in src, 'codexArgs block not found — already patched?'
src = src.replace(old, new, 1)
p.write_text(src)
print('patched, len=', len(src))
PY

echo ""
echo "=== 2. remove the rewritten config.toml (no longer needed) ==="
rm -f /home/codexsbx/.codex/config.toml
ls -la /home/codexsbx/.codex/config.toml 2>&1 || echo "(removed)"

echo ""
echo "=== 3. restart ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service

echo ""
echo "=== 4. smoke test #1 (clean state) ==="
time curl -sS --max-time 60 http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"reply with: ALPHA BRAVO CHARLIE","timeoutSec":50}'
echo ""

echo ""
echo "=== 5. smoke test #2 (immediately after, verify no state drift) ==="
time curl -sS --max-time 60 http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"reply with: DELTA ECHO FOXTROT","timeoutSec":50}'
echo ""

echo ""
echo "=== 6. confirm no config.toml regenerated ==="
ls -la /home/codexsbx/.codex/config.toml 2>&1 || echo "(still not regenerated — perfect)"

echo ""
echo "=== 7. orphan check ==="
ps -eo pid,user,etimes,cmd | grep -E 'codex' | grep -v grep | grep -v 'server.js' || echo "(no orphans)"

echo ""
echo "=== DONE ==="

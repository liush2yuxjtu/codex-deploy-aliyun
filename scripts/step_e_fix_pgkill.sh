#!/bin/bash
set -e

echo "=== 0. kill any orphan codex processes ==="
pkill -KILL -f 'codex-linux-x64.*vendor.*bin/codex' || true
pkill -KILL -f 'codex exec' || true
sleep 1
ps -eo pid,user,cmd | grep -E 'codex' | grep -v grep || echo "(no codex processes)"

echo ""
echo "=== 1. patch server.js: add node to PATH, use detached + process-group kill ==="
python3 <<'PY'
import pathlib, re
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# 1. PATH fix
old_path = "PATH: '/usr/local/bin:/usr/bin:/bin',"
new_path = "PATH: '/opt/node-v20.18.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin',"
assert old_path in src, 'PATH pattern not found'
src = src.replace(old_path, new_path, 1)

# 2. detached spawn so we can kill the process group
old_block = """  const started = Date.now();
  const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    env: {"""
new_block = """  const started = Date.now();
  const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    detached: true,
    env: {"""
assert old_block in src
src = src.replace(old_block, new_block, 1)

# 3. kill the whole process group (-pgid), not just the child
old_kill = """  const killTimer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutS * 1000);"""
new_kill = """  const killTimer = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (e) { try { child.kill('SIGKILL'); } catch {} }
  }, timeoutS * 1000);"""
assert old_kill in src
src = src.replace(old_kill, new_kill, 1)

p.write_text(src)
print('patched, len=', len(src))
PY

echo ""
echo "=== 2. restart + verify ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
curl -sS http://127.0.0.1:3030/healthz; echo

echo ""
echo "=== 3. direct codex run (sanity) with correct PATH this time ==="
TMPDIR=$(mktemp -d /tmp/cx.XXXXXX); chown codexsbx:codexsbx "$TMPDIR"
echo "--- bogus key, --dangerously-bypass-approvals-and-sandbox ---"
time sudo -u codexsbx env \
  PATH=/opt/node-v20.18.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  OPENAI_API_KEY=sk-test-invalid HOME=/home/codexsbx NO_COLOR=1 TERM=dumb \
  timeout 20 /opt/node-v20.18.1-linux-x64/bin/codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --skip-git-repo-check \
    --ephemeral \
    --color never \
    -C "$TMPDIR" \
    "say hi" 2>&1 | head -40
echo "--- exit=$? ---"
rm -rf "$TMPDIR"

echo ""
echo "=== 4. smoke test via HTTP API with bogus key (timeoutSec 20) ==="
time curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 30 \
  -d '{"prompt":"say hi","apiKey":"sk-test-invalid","timeoutSec":20}' | head -c 3000
echo ""

echo ""
echo "=== 5. orphan check after ==="
sleep 2
ps -eo pid,user,etimes,cmd | grep -E 'codex' | grep -v grep || echo "(no codex orphans)"

echo ""
echo "=== DONE patch v2 ==="

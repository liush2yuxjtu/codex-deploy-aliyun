#!/bin/bash
set -e
echo "=== find runuser path (for reference) ==="
which runuser || true
ls -la /sbin/runuser /usr/sbin/runuser 2>&1 | head -3
echo ""
echo "=== get codexsbx uid/gid ==="
id codexsbx
echo ""
echo "=== patch server.js: replace runuser spawn with native uid/gid spawn ==="
python3 <<'PY'
import re, pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()
# capture uid/gid at module load
header_addon = """
const { execSync: _execSync } = require('child_process');
const SANDBOX_UID = parseInt(_execSync(`id -u ${'codexsbx'}`).toString().trim(), 10);
const SANDBOX_GID = parseInt(_execSync(`id -g ${'codexsbx'}`).toString().trim(), 10);
"""
src = src.replace(
    "const DEFAULT_TIMEOUT = 90;",
    header_addon + "const DEFAULT_TIMEOUT = 90;",
    1,
)
# replace the runuser spawn block with native uid/gid spawn
old_spawn = """  // wrap with runuser to drop privileges to codexsbx
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
  });"""
new_spawn = """  const started = Date.now();
  const child = spawn(CODEX_BIN, codexArgs, {
    uid: SANDBOX_UID,
    gid: SANDBOX_GID,
    cwd: workDir,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: `/home/${SANDBOX_USER}`,
      USER: SANDBOX_USER,
      OPENAI_API_KEY: apiKey,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });"""
assert old_spawn in src, 'pattern not found'
src = src.replace(old_spawn, new_spawn, 1)
p.write_text(src)
print('patched', p, 'len=', len(src))
PY

echo ""
echo "=== restart service ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
journalctl -u codex-api.service -n 10 --no-pager

echo ""
echo "=== local smoke test with bogus key (proves wiring) ==="
curl -sS http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  --max-time 45 \
  -d '{"prompt":"say hi in one word","apiKey":"sk-test-invalid-key-for-wiring-check","timeoutSec":30}'
echo ""
echo ""
echo "=== journal after smoke test ==="
journalctl -u codex-api.service -n 20 --no-pager | tail -20

echo ""
echo "=== DONE patch ==="

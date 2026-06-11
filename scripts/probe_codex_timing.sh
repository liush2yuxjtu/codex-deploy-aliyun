#!/bin/bash
set +e
echo "=== A. direct codex run as codexsbx with BOGUS key — what happens? ==="
TMPDIR=$(mktemp -d /tmp/cx.XXXXXX)
chown codexsbx:codexsbx "$TMPDIR"
echo "--- attempt with --dangerously-bypass-approvals-and-sandbox (yolo equivalent) ---"
time sudo -u codexsbx env OPENAI_API_KEY=sk-test-invalid HOME=/home/codexsbx \
  timeout 25 /opt/node-v20.18.1-linux-x64/bin/codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --skip-git-repo-check \
    --ephemeral \
    --color never \
    -C "$TMPDIR" \
    "say hi in one word" 2>&1 | head -50
echo "--- exit=$? ---"
echo ""
rm -rf "$TMPDIR"

echo ""
echo "=== B. simpler: bypass + workspace-write redundant — drop bypass flag ==="
TMPDIR=$(mktemp -d /tmp/cx.XXXXXX); chown codexsbx:codexsbx "$TMPDIR"
echo "--- with -s workspace-write + -c approval_policy='never' ---"
time sudo -u codexsbx env OPENAI_API_KEY=sk-test-invalid HOME=/home/codexsbx \
  timeout 25 /opt/node-v20.18.1-linux-x64/bin/codex exec \
    -s workspace-write \
    -c 'approval_policy="never"' \
    --skip-git-repo-check \
    --ephemeral \
    --color never \
    -C "$TMPDIR" \
    "say hi in one word" 2>&1 | head -50
echo "--- exit=$? ---"
rm -rf "$TMPDIR"

echo ""
echo "=== C. check journalctl for any codex-api activity in last minute ==="
journalctl -u codex-api.service --since '2 minutes ago' --no-pager | tail -25

echo ""
echo "=== D. find what processes the API spawned (leak check) ==="
ps -eo pid,ppid,user,etimes,cmd | grep -E '(codex|node /opt/codex)' | grep -v grep | head -20

echo ""
echo "=== E. check what tmpdir/auth files codex tries to read (strace) ==="
TMPDIR=$(mktemp -d /tmp/cx.XXXXXX); chown codexsbx:codexsbx "$TMPDIR"
sudo -u codexsbx env OPENAI_API_KEY=sk-test-invalid HOME=/home/codexsbx \
  timeout 5 strace -f -e openat,connect -o /tmp/cx_trace.txt \
  /opt/node-v20.18.1-linux-x64/bin/codex exec \
    --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --color never \
    -C "$TMPDIR" "hi" 2>&1 | head -5
echo "--- last 20 trace lines ---"
tail -30 /tmp/cx_trace.txt 2>/dev/null | grep -E '(\.codex|auth|connect|openai|api\.openai)' | head -20
rm -rf "$TMPDIR" /tmp/cx_trace.txt

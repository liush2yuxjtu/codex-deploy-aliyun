#!/bin/bash
set -e

echo "=== 1. apply targeted patch: clientIp + recordRun in close handler ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# A. Add clientIp capture at top of handleRun (if not already there)
if 'const clientIp =' not in src:
    src = src.replace(
        "async function handleRun(req, res) {\n  const raw = await readBody(req);",
        "async function handleRun(req, res) {\n  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;\n  const raw = await readBody(req);",
        1
    )
    print('A: clientIp added')
else:
    print('A: clientIp already present')

# B. Replace the close handler — exact text from current deployed server.js
old_close = """  child.on('close', (code) => {
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
  });"""

new_close = """  child.on('close', (code) => {
    clearTimeout(killTimer);
    const durationMs = Date.now() - started;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

    let payload, status;
    if (killed) {
      status = 504;
      payload = { ok: false, error: `timed out after ${timeoutS}s`, runId, durationMs, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    } else if (code === 0) {
      status = 200;
      payload = { ok: true, exitCode: code, runId, durationMs, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    } else {
      status = 502;
      payload = { ok: false, exitCode: code, runId, durationMs, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
    }
    json(res, status, payload);

    // fire-and-forget persistence
    Promise.resolve().then(() => recordRun({
      runId, prompt, model: effectiveModel || null,
      exitCode: payload.exitCode ?? null,
      durationMs, stdout: payload.stdout, stderr: payload.stderr,
      ok: !!payload.ok, error: payload.error || null,
      clientIp,
    })).catch(e => console.error('[recordRun outer]', e.message));
  });"""

if old_close in src:
    src = src.replace(old_close, new_close, 1)
    print('B: close handler patched')
elif 'recordRun({' in src:
    print('B: already patched (recordRun call present)')
else:
    raise SystemExit('B: old_close pattern not found, manual investigation needed')

p.write_text(src)
print('len=', len(src))
PY

echo ""
echo "=== 2. restart ==="
systemctl restart codex-api.service
sleep 2
systemctl is-active codex-api.service
journalctl -u codex-api.service -n 5 --no-pager

echo ""
echo "=== 3. trigger /run + watch for persistence ==="
RESP=$(curl -sS --max-time 30 http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"reply: persistence test 2","timeoutSec":25}')
echo "$RESP" | head -c 300
echo
RID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('runId',''))")
echo "runId: $RID"

sleep 2
echo ""
echo "--- DB row for that runId ---"
PGPASSWORD="$RDS_PASSWORD" psql \
  -h "$RDS_PUBLIC" -p "$RDS_PORT" \
  -U "$RDS_ADMIN" -d "$RDS_DB" \
  -c "SELECT id, run_id, model, exit_code, duration_ms, ok, LEFT(stdout,80) AS preview, created_at FROM codex_runs WHERE run_id='$RID' OR id > 0 ORDER BY id DESC LIMIT 5;" 2>&1

echo ""
echo "--- /history endpoint ---"
curl -sS http://127.0.0.1:3030/history?limit=5 | python3 -m json.tool 2>&1 | head -40

echo ""
echo "--- journal (look for [recordRun] errors if any) ---"
journalctl -u codex-api.service --since "30 seconds ago" --no-pager | grep -i 'recordrun\|error\|pool' | head -10 || echo "(no errors)"

echo ""
echo "=== DONE ==="

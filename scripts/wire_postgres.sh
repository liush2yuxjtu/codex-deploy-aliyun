#!/bin/bash
set -e

# Load secrets from repo .env (Mac dev) or /etc/codex-api/secret.env (SWAS)
SECRETS_FILE="${SECRETS_FILE:-$(dirname "$0")/../.env}"
[ -f "$SECRETS_FILE" ] && { set -a; . "$SECRETS_FILE"; set +a; }
[ -z "$RDS_PASSWORD" ] && [ -f /etc/codex-api/secret.env ] && . /etc/codex-api/secret.env
: "${RDS_PUBLIC:?RDS_PUBLIC not set — need $SECRETS_FILE or /etc/codex-api/secret.env}"
: "${RDS_DB:?RDS_DB not set}"
: "${RDS_ADMIN:?RDS_ADMIN not set}"
: "${RDS_PASSWORD:?RDS_PASSWORD not set}"

echo "=== 1. create schema (codex_runs + index) ==="
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_PUBLIC" -p 5432 -U "$RDS_ADMIN" -d "$RDS_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS codex_runs (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL UNIQUE,
  prompt      TEXT NOT NULL,
  model       TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  ok          BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT,
  client_ip   INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codex_runs_created_at_desc ON codex_runs (created_at DESC);

-- show
\d codex_runs
SELECT count(*) AS row_count FROM codex_runs;
SQL

echo ""
echo "=== 2. append RDS creds to /etc/codex-api/secret.env ==="
grep -v '^RDS_' /etc/codex-api/secret.env > /tmp/secret.env.new || cp /etc/codex-api/secret.env /tmp/secret.env.new
cat >> /tmp/secret.env.new <<EOF
RDS_HOST=$RDS_PUBLIC
RDS_PORT=5432
RDS_DB=$RDS_DB
RDS_USER=$RDS_ADMIN
RDS_PASSWORD=$RDS_PASSWORD
EOF
mv /tmp/secret.env.new /etc/codex-api/secret.env
chmod 600 /etc/codex-api/secret.env
chown root:root /etc/codex-api/secret.env
echo "secret.env updated. fields:"
grep -E '^[A-Z_]+=' /etc/codex-api/secret.env | sed 's/=.*/=<hidden>/'

echo ""
echo "=== 3. install pg npm module globally ==="
cd /opt/codex-api
[ -f package.json ] || cat > package.json <<'PJ'
{
  "name": "codex-api",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "dependencies": { "pg": "^8.13.0" }
}
PJ
npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | tail -5
ls node_modules/pg/package.json && echo "pg installed: $(node -e 'console.log(require(\"./node_modules/pg/package.json\").version)')"

echo ""
echo "=== 4. patch server.js: add pg pool + persist /run + new /history ==="
python3 <<'PY'
import pathlib
p = pathlib.Path('/opt/codex-api/server.js')
src = p.read_text()

# --- A. Load RDS creds + create pg pool near the top ---
anchor = "let SERVER_LLM_API_KEY = '';"
addon = """let RDS_HOST='', RDS_PORT=5432, RDS_DB='', RDS_USER='', RDS_PASSWORD='';
"""
if 'RDS_HOST' not in src:
    src = src.replace(anchor, addon + anchor, 1)

# Extend the secret-loading loop
old_loader = """    if (m[1] === 'LLM_API_KEY') SERVER_LLM_API_KEY = m[2].trim();
    if (m[1] === 'LLM_DEFAULT_MODEL') SERVER_LLM_DEFAULT_MODEL = m[2].trim();"""
new_loader = """    if (m[1] === 'LLM_API_KEY') SERVER_LLM_API_KEY = m[2].trim();
    if (m[1] === 'LLM_DEFAULT_MODEL') SERVER_LLM_DEFAULT_MODEL = m[2].trim();
    if (m[1] === 'RDS_HOST') RDS_HOST = m[2].trim();
    if (m[1] === 'RDS_PORT') RDS_PORT = parseInt(m[2].trim(), 10) || 5432;
    if (m[1] === 'RDS_DB') RDS_DB = m[2].trim();
    if (m[1] === 'RDS_USER') RDS_USER = m[2].trim();
    if (m[1] === 'RDS_PASSWORD') RDS_PASSWORD = m[2].trim();"""
if old_loader in src:
    src = src.replace(old_loader, new_loader, 1)

# Add pg pool after the secret loader (find the catch block)
pg_init = """
// ─── pg pool (history persistence) ───
let pgPool = null;
if (RDS_HOST && RDS_DB && RDS_USER) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      host: RDS_HOST, port: RDS_PORT, database: RDS_DB,
      user: RDS_USER, password: RDS_PASSWORD,
      ssl: false,
      max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000,
    });
    pgPool.on('error', (e) => console.error('[pg pool error]', e.message));
    console.log('[codex-api] pg pool initialised → ' + RDS_USER + '@' + RDS_HOST + '/' + RDS_DB);
  } catch (e) {
    console.error('[codex-api] pg init failed:', e.message);
    pgPool = null;
  }
} else {
  console.log('[codex-api] no RDS_* env — running without history persistence');
}

async function recordRun(row) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO codex_runs(run_id, prompt, model, exit_code, duration_ms, stdout, stderr, ok, error, client_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.runId, row.prompt, row.model, row.exitCode ?? null,
       row.durationMs ?? null,
       (row.stdout || '').slice(0, 200000),
       (row.stderr || '').slice(0, 40000),
       !!row.ok,
       row.error || null,
       row.clientIp || null]
    );
  } catch (e) {
    console.error('[recordRun] insert failed:', e.message);
  }
}
"""
if 'pgPool' not in src:
    # insert pg_init after the SECRET_FILE try/catch closing brace.
    marker = "console.log('[codex-api] no secret file at', SECRET_FILE, '— requests must supply apiKey');\n}"
    if marker in src:
        src = src.replace(marker, marker + '\n' + pg_init, 1)
    else:
        # fallback: insert before the readBody function
        marker2 = "function readBody(req, maxBytes ="
        src = src.replace(marker2, pg_init + '\n' + marker2, 1)

# --- B. handleRun: capture clientIp + persist on close ---
# Add clientIp grab at the top of handleRun
old_h = """async function handleRun(req, res) {
  const raw = await readBody(req);"""
new_h = """async function handleRun(req, res) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;
  const raw = await readBody(req);"""
if 'clientIp' not in src:
    src = src.replace(old_h, new_h, 1)

# Find the spot where prompt/effectiveModel are determined and capture for persistence
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
    let payload;
    if (killed) {
      payload = { ok: false, error: `timed out after ${timeoutS}s`, runId, durationMs, stdout, stderr };
      res.statusCode = 504;
    } else if (code === 0) {
      payload = { ok: true, exitCode: code, runId, durationMs, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
      res.statusCode = 200;
    } else {
      payload = { ok: false, exitCode: code, runId, durationMs, stdout: stdout.slice(-65536), stderr: stderr.slice(-8192) };
      res.statusCode = 502;
    }
    const body = JSON.stringify(payload);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    // fire-and-forget persistence (don't block response)
    recordRun({
      runId, prompt, model: effectiveModel || null,
      exitCode: payload.exitCode ?? null,
      durationMs, stdout: payload.stdout, stderr: payload.stderr,
      ok: !!payload.ok, error: payload.error || null,
      clientIp,
    });
  });"""
if 'recordRun(' not in src:
    src = src.replace(old_close, new_close, 1)

# --- C. add GET /history endpoint ---
old_404 = """  json(res, 404, { ok: false, error: 'not found' });
});"""
new_404 = """  // ─── history ───
  if (req.method === 'GET' && url.pathname === '/history') {
    if (!pgPool) return json(res, 200, { ok: true, rows: [], note: 'no db configured' });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    try {
      const r = await pgPool.query(
        `SELECT run_id, prompt, model, exit_code, duration_ms, ok, created_at,
                LEFT(stdout, 800)  AS stdout_preview,
                LEFT(stderr, 400)  AS stderr_preview
           FROM codex_runs
           ORDER BY created_at DESC
           LIMIT $1`, [limit]
      );
      return json(res, 200, { ok: true, rows: r.rows });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
    if (!pgPool) return json(res, 404, { ok: false, error: 'no db' });
    const runId = url.pathname.slice('/history/'.length);
    try {
      const r = await pgPool.query(`SELECT * FROM codex_runs WHERE run_id = $1`, [runId]);
      if (!r.rows.length) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, row: r.rows[0] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  json(res, 404, { ok: false, error: 'not found' });
});"""
if '/history' not in src:
    src = src.replace(old_404, new_404, 1)

# --- D. healthz: also surface db connectivity ---
old_hz = """    return json(res, 200, {
      ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT,
      authRequired: !!SHARED_SECRET,
      serverHasDefaultKey: !!SERVER_LLM_API_KEY,
      defaultModel: SERVER_LLM_DEFAULT_MODEL || null,
    });"""
new_hz = """    let dbOk = null;
    if (pgPool) {
      try { await pgPool.query('SELECT 1'); dbOk = true; }
      catch (e) { dbOk = false; }
    }
    return json(res, 200, {
      ok: true, codex: CODEX_BIN, user: SANDBOX_USER, port: PORT,
      authRequired: !!SHARED_SECRET,
      serverHasDefaultKey: !!SERVER_LLM_API_KEY,
      defaultModel: SERVER_LLM_DEFAULT_MODEL || null,
      db: pgPool ? { host: RDS_HOST, name: RDS_DB, ok: dbOk } : null,
    });"""
if 'dbOk' not in src:
    src = src.replace(old_hz, new_hz, 1)

# make /healthz handler async (it does await pgPool.query)
src = src.replace(
    "if (req.method === 'GET' && url.pathname === '/healthz') {",
    "if (req.method === 'GET' && url.pathname === '/healthz') {  // async",
    1
)

p.write_text(src)
print('patched, len=', len(src))
PY

echo ""
echo "=== 5. restart ==="
systemctl restart codex-api.service
sleep 3
systemctl is-active codex-api.service
journalctl -u codex-api.service -n 10 --no-pager

echo ""
echo "=== 6. smoke tests ==="
echo "--- healthz (should show db.ok=true) ---"
curl -sS http://127.0.0.1:3030/healthz | python3 -m json.tool

echo ""
echo "--- /run a real prompt (will persist to DB) ---"
time curl -sS --max-time 90 http://127.0.0.1:3030/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"reply with exactly: persisted to postgres","timeoutSec":60}' | python3 -m json.tool 2>&1 | head -20

echo ""
echo "--- /history (should have 1 row) ---"
curl -sS http://127.0.0.1:3030/history?limit=5 | python3 -m json.tool 2>&1 | head -30

echo ""
echo "--- PG view directly ---"
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_PUBLIC" -p 5432 -U "$RDS_ADMIN" -d "$RDS_DB" \
  -c "SELECT id, run_id, model, exit_code, duration_ms, ok, created_at, LEFT(stdout, 50) AS preview FROM codex_runs ORDER BY created_at DESC LIMIT 5;" 2>&1

echo ""
echo "=== DONE ==="

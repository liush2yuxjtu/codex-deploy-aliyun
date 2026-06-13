// server/users.js — multi-user identity helpers (mu-001, PRD §5).
//
// Token shape:
//   plaintext  = base64url(crypto.randomBytes(24))   (32 chars, URL-safe)
//   stored     = sha256(plaintext), hex-encoded      (64 chars)
// Lookup: WHERE api_token_sha256 = $1 AND revoked_at IS NULL.
//
// The plaintext is returned to the caller exactly once at mint. The DB
// never sees the plaintext again. This is the AP-3 contract — there is
// no admin / API path to re-mint without a new row, and the helper
// module never logs the plaintext (only the sha256).
//
// Sentinel: id='system' is reserved for the SHARED_SECRET / DEMO_SECRET
// user and is NOT a real row. mintUser() rejects name='system' before
// INSERT as AP-5's belt-and-braces guard against the UNIQUE constraint
// ever silently accepting a collision.
//
// Result enum (RESOLVE_USER_RESULT): the documented return shapes for
// resolveToken(); the middleware in server.js depends on these.
//
// All functions are async + best-effort log-on-failure (mirroring
// recordRun / insertCodexJob). A DB outage never crashes the server
// — but a failed resolveToken() will simply return null and the
// caller treats that as 401.

const crypto = require('crypto');

const RESOLVE_USER_RESULT = Object.freeze({
  OK:        'ok',          // user row found
  NOT_FOUND: 'not_found',   // no row for this token sha256
  REVOKED:   'revoked',     // row exists but revoked_at IS NOT NULL
});

const SENTINEL_SYSTEM_NAME = 'system';
const ID_PREFIX = 'cdx_';

// Generates a cdx_<nanoid> style id. We do NOT pull in the `nanoid`
// package — this is a 12-char URL-safe random with a fixed prefix,
// which is enough for the admin eyeball / IM channel + the audit
// regex `^cdx_[A-Za-z0-9_-]+$` (PRD §5 key decision).
function newUserId() {
  // 9 bytes → 12 base64url chars. crypto is already required by
  // server.js at the top of the file.
  return ID_PREFIX + crypto.randomBytes(9).toString('base64url');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

// PUBLIC: mintUser({ name, label? }) -> { id, name, label, apiToken, createdAt }
//
// name must be non-empty. name === 'system' is rejected (sentinel
// collision per AP-5). label is optional and is stored verbatim.
// The plaintext apiToken is returned in the result; the DB only sees
// the sha256 hash. Caller is responsible for surfacing apiToken to the
// admin exactly once.
//
// Throws:
//   { code: 'BAD_NAME' }      — name missing / empty / not a string
//   { code: 'NAME_TAKEN' }    — UNIQUE constraint violation
//   { code: 'SENTINEL_SYSTEM' } — name === 'system' (rejected pre-INSERT)
async function mintUser({ name, label } = {}, deps = {}) {
  const pgPool = deps.pgPool || (typeof globalThis.__pgPool === 'function' ? globalThis.__pgPool() : null);
  if (!pgPool) throw new Error('mintUser: pgPool not available');
  if (typeof name !== 'string' || !name.trim()) {
    const e = new Error('mintUser: name is required');
    e.code = 'BAD_NAME';
    throw e;
  }
  const cleanName = name.trim();
  if (cleanName === SENTINEL_SYSTEM_NAME) {
    const e = new Error("mintUser: name 'system' is reserved (sentinel)");
    e.code = 'SENTINEL_SYSTEM';
    throw e;
  }
  const id = newUserId();
  const apiToken = crypto.randomBytes(24).toString('base64url');   // 32 chars
  const apiTokenSha256 = sha256Hex(apiToken);
  const cleanLabel = (typeof label === 'string' && label.trim()) ? label.trim() : null;
  try {
    const r = await pgPool.query(
      `INSERT INTO users (id, name, api_token_sha256, label)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, label, created_at`,
      [id, cleanName, apiTokenSha256, cleanLabel]
    );
    const row = r.rows[0];
    return {
      id: row.id,
      name: row.name,
      label: row.label,
      apiToken,                                // plaintext — exactly once
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  } catch (e) {
    // Postgres UNIQUE violation = 23505.
    if (e && e.code === '23505') {
      const err = new Error('mintUser: name already taken: ' + cleanName);
      err.code = 'NAME_TAKEN';
      throw err;
    }
    throw e;
  }
}

// PUBLIC: resolveToken(token) -> { kind: 'ok' | 'not_found' | 'revoked', user?: {...} }
//
// Looks up the user by sha256(token) AND revoked_at IS NULL.
// On hit, fires a best-effort UPDATE last_used_at = now() in the
// background (fire-and-forget; the lookup result does not wait).
// Returns:
//   { kind: 'ok',        user: { id, name, label, isSystem: false } }
//   { kind: 'revoked',   user: { id, name, label, isSystem: false } }   // row exists but revoked
//   { kind: 'not_found', user: null }                                    // no row
//   { kind: 'no_db',     user: null }                                    // pgPool missing
async function resolveToken(token, deps = {}) {
  const pgPool = deps.pgPool || (typeof globalThis.__pgPool === 'function' ? globalThis.__pgPool() : null);
  if (!pgPool) return { kind: 'no_db', user: null };
  if (!token || typeof token !== 'string') return { kind: 'not_found', user: null };
  const sha = sha256Hex(token);
  let r;
  try {
    r = await pgPool.query(
      `SELECT id, name, label, revoked_at FROM users WHERE api_token_sha256 = $1 LIMIT 1`,
      [sha]
    );
  } catch (e) {
    // DB error — fail closed (no auth). Mirror recordRun's log-on-failure.
    if (typeof globalThis.__slog === 'function') {
      globalThis.__slog('warn', '[users.resolveToken] db error: ' + (e && e.message || e));
    } else {
      console.warn('[users.resolveToken] db error:', e && e.message || e);
    }
    return { kind: 'not_found', user: null };
  }
  if (!r.rows.length) return { kind: 'not_found', user: null };
  const row = r.rows[0];
  const user = {
    id: row.id,
    name: row.name,
    label: row.label || null,
    isSystem: false,
  };
  if (row.revoked_at) return { kind: 'revoked', user };
  // Best-effort last_used_at update — do not block the caller.
  Promise.resolve().then(() => {
    pgPool.query(`UPDATE users SET last_used_at = now() WHERE id = $1`, [user.id])
      .catch(e => {
        if (typeof globalThis.__slog === 'function') {
          globalThis.__slog('warn', '[users.resolveToken] last_used_at update failed: ' + (e && e.message || e));
        }
      });
  }).catch(() => {});
  return { kind: 'ok', user };
}

// PUBLIC: revokeUser(id) -> { revokedAt } | null
//
// Sets revoked_at = now() if not already set. Returns the new
// revokedAt (ISO string), or null if the row doesn't exist.
// Best-effort log on DB error.
async function revokeUser(id, deps = {}) {
  const pgPool = deps.pgPool || (typeof globalThis.__pgPool === 'function' ? globalThis.__pgPool() : null);
  if (!pgPool) throw new Error('revokeUser: pgPool not available');
  if (!id || typeof id !== 'string') return null;
  const r = await pgPool.query(
    `UPDATE users SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
      RETURNING id, revoked_at`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at,
  };
}

// PUBLIC: getStats(id) -> { id, name, label, createdAt, lastUsedAt, revokedAt, runs, jobs, pdfs }
//
// Returns the user row + counts from codex_runs, codex_jobs, and
// pdf_jobs. pdf_jobs is added in a later migration (mu-006), so
// the pdfs count is wrapped in a try/catch and defaults to 0 when
// the table doesn't exist yet. This is a defensive default — the
// shape of the result is fixed from mu-001 onwards.
//
// Returns null when the row doesn't exist.
async function getStats(id, deps = {}) {
  const pgPool = deps.pgPool || (typeof globalThis.__pgPool === 'function' ? globalThis.__pgPool() : null);
  if (!pgPool) throw new Error('getStats: pgPool not available');
  if (!id || typeof id !== 'string') return null;
  const r = await pgPool.query(
    `SELECT id, name, label, created_at, last_used_at, revoked_at
       FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const [runsR, jobsR, pdfsR] = await Promise.all([
    pgPool.query(`SELECT count(*)::int AS n FROM codex_runs WHERE user_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] })),
    pgPool.query(`SELECT count(*)::int AS n FROM codex_jobs WHERE user_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] })),
    // pdf_jobs.user_id is mu-006; not present in this slice. Default 0.
    pgPool.query(`SELECT count(*)::int AS n FROM pdf_jobs WHERE user_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] })),
  ]);
  return {
    id: row.id,
    name: row.name,
    label: row.label || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    lastUsedAt: row.last_used_at ? (row.last_used_at instanceof Date ? row.last_used_at.toISOString() : row.last_used_at) : null,
    revokedAt: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at) : null,
    runs: runsR.rows[0].n,
    jobs: jobsR.rows[0].n,
    pdfs: pdfsR.rows[0].n,
    // bug-010: live per-user queue depth via the userSlots bridge
    // populated by server.js. Defensive — server may not have wired
    // the bridge yet (test harnesses, scripts).
    // __userSlots is a lazy accessor () => Map; call it to deref.
    queued: (() => { try { const slots = (typeof globalThis.__userSlots === 'function' ? globalThis.__userSlots() : null); return (slots && (slots.get(id) || { queued: [] }).queued.length) || 0; } catch { return 0; } })(),
  };
}

// PUBLIC: listUsers() -> [{ id, name, label, createdAt, lastUsedAt, revokedAt }]
//
// Ordered by created_at DESC. Never returns api_token_sha256.
async function listUsers(deps = {}) {
  const pgPool = deps.pgPool || (typeof globalThis.__pgPool === 'function' ? globalThis.__pgPool() : null);
  if (!pgPool) throw new Error('listUsers: pgPool not available');
  const r = await pgPool.query(
    `SELECT id, name, label, created_at, last_used_at, revoked_at
       FROM users
       ORDER BY created_at DESC`
  );
  return r.rows.map(row => ({
    id: row.id,
    name: row.name,
    label: row.label || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    lastUsedAt: row.last_used_at ? (row.last_used_at instanceof Date ? row.last_used_at.toISOString() : row.last_used_at) : null,
    revokedAt: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at) : null,
  }));
}

module.exports = {
  RESOLVE_USER_RESULT,
  SENTINEL_SYSTEM_NAME,
  ID_PREFIX,
  newUserId,
  sha256Hex,
  mintUser,
  resolveToken,
  revokeUser,
  getStats,
  listUsers,
};

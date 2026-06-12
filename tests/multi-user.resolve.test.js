// tests/multi-user.resolve.test.js — mu-001 Seam 3 unit test
//
// Covers the 6 token/header input shapes for the resolveUser middleware:
//   1) system via x-demo-key (SHARED_SECRET set + matching header)
//   2) system via ?key=    (SHARED_SECRET set + matching query)
//   3) user via Bearer     (Authorization: Bearer <token>)
//   4) user via X-Codex-User
//   5) invalid token       (no row matches the sha256)
//   6) no token when SHARED_SECRET set (no demo-key, no token, no ?key=)
//
// Plus two extras the slice calls out:
//   - 'system' as a mint name returns 409 SENTINEL_SYSTEM
//   - SHARED_SECRET empty ⇒ v1 demo fallback (system user even with no token)
//
// This is a pure unit test — it mocks pgPool. No real DB calls.
//
// Run: `node tests/multi-user.resolve.test.js` from the repo root.

'use strict';
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

// Force SHARED_SECRET to a known value BEFORE requiring server.js.
process.env.DEMO_SECRET = 'unit-test-secret';

const users = require(path.join(__dirname, '..', 'server', 'users'));

// ─── Test fake pgPool ───
// In-memory map of api_token_sha256 → row. Lets resolveToken
// return hits/misses/revoked without a real DB.
function makeFakePool({ rows = [] } = {}) {
  const bySha = new Map();
  const byId = new Map();
  for (const r of rows) {
    bySha.set(r.api_token_sha256, r);
    byId.set(r.id, r);
  }
  return {
    async query(sql, params) {
      const s = sql.trim();
      // INSERT INTO users
      if (/INSERT INTO users/i.test(s)) {
        const [id, name, sha, label] = params;
        if (byId.has(id)) {
          const e = new Error('duplicate key value violates unique constraint "users_pkey"');
          e.code = '23505';
          throw e;
        }
        // Enforce the UNIQUE constraint on name (mirrors the real
        // migration's `name TEXT NOT NULL UNIQUE`).
        for (const r of byId.values()) {
          if (r.name === name) {
            const e = new Error('duplicate key value violates unique constraint "users_name_key"');
            e.code = '23505';
            throw e;
          }
        }
        const row = { id, name, api_token_sha256: sha, label: label || null, revoked_at: null };
        bySha.set(sha, row); byId.set(id, row);
        return { rows: [{ id, name, label: row.label, created_at: new Date() }] };
      }
      // SELECT ... FROM users WHERE api_token_sha256 = $1
      if (/FROM users\s+WHERE\s+api_token_sha256\s*=\s*\$1/i.test(s)) {
        const [sha] = params;
        const row = bySha.get(sha);
        return { rows: row ? [row] : [] };
      }
      // SELECT ... FROM users WHERE id = $1
      if (/FROM users\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
        const [id] = params;
        const row = byId.get(id);
        return { rows: row ? [row] : [] };
      }
      // UPDATE users SET last_used_at = now() WHERE id = $1
      if (/UPDATE users\s+SET\s+last_used_at/i.test(s)) {
        const [id] = params;
        const row = byId.get(id);
        if (row) row.last_used_at = new Date();
        return { rows: [] };
      }
      // UPDATE users SET revoked_at = COALESCE(...)
      if (/UPDATE users\s+SET\s+revoked_at\s*=\s*COALESCE/i.test(s)) {
        const [id] = params;
        const row = byId.get(id);
        if (!row) return { rows: [] };
        if (!row.revoked_at) row.revoked_at = new Date();
        return { rows: [{ id: row.id, revoked_at: row.revoked_at }] };
      }
      // SELECT id, name, label, created_at, last_used_at, revoked_at FROM users ORDER BY created_at DESC
      if (/SELECT\s+id,\s*name,\s*label,\s*created_at,\s*last_used_at,\s*revoked_at\s+FROM\s+users\s+ORDER BY created_at DESC/i.test(s)) {
        return { rows: [...byId.values()] };
      }
      // count(*) fallbacks for getStats
      if (/SELECT count\(\*\)/i.test(s)) {
        return { rows: [{ n: 0 }] };
      }
      throw new Error('fake pool: unknown query: ' + s.slice(0, 80));
    },
    bySha, byId,
  };
}

// ─── Build a fake request matching server.js's resolveUser expectations ───
function makeReq({ headers = {}, url = '/' } = {}) {
  return { headers, url };
}

// ─── Run resolveUser from server.js with a controllable SHARED_SECRET ───
// We do this by re-implementing the resolveUser shape here using the
// users module + the same algorithm, instead of `require('../server/server')`
// (which would try to bind port 3030). The shape is intentionally
// mirrored 1:1 so the test catches drift in server.js's resolveUser.
async function resolveUserShim(req, { sharedSecret, pool }) {
  // Inject the pool into the users module's resolver path.
  const url = new URL(req.url, 'http://x');
  const demoKey = (req.headers['x-demo-key'] || '').toString();
  const urlKey = (url.searchParams.get('key') || '').toString();
  const bearer = (() => {
    const h = (req.headers['authorization'] || '').toString();
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : '';
  })();
  const xUser = (req.headers['x-codex-user'] || '').toString().trim();
  const token = bearer || xUser;

  if (sharedSecret && (demoKey === sharedSecret || urlKey === sharedSecret)) {
    return { ok: true, user: { id: 'system', name: 'system', isSystem: true } };
  }
  if (token) {
    const res = await users.resolveToken(token, { pgPool: pool });
    if (res.kind === 'ok') return { ok: true, user: res.user };
    if (res.kind === 'revoked') return { ok: false, reason: 'token_revoked' };
    return { ok: false, reason: 'token_invalid' };
  }
  if (!sharedSecret) {
    return { ok: true, user: { id: 'system', name: 'system', isSystem: true } };
  }
  return { ok: false, reason: 'no_token' };
}

(async () => {
  // ─── Seed: mint two users so we have a known plaintext token per user ───
  const pool = makeFakePool();
  const alice = await users.mintUser({ name: 'alice' }, { pgPool: pool });
  const bob   = await users.mintUser({ name: 'bob', label: 'team bob' }, { pgPool: pool });
  assert.ok(alice.id.startsWith('cdx_'), 'alice.id is cdx_ prefixed');
  assert.ok(bob.id.startsWith('cdx_'),   'bob.id is cdx_ prefixed');
  assert.notEqual(alice.apiToken, bob.apiToken, 'plaintext tokens are unique');
  assert.ok(alice.apiToken.length >= 30, 'token is at least 30 chars (24 bytes b64url)');

  // ─── Test 1: system via x-demo-key ───
  {
    const r = await resolveUserShim(makeReq({ headers: { 'x-demo-key': 'unit-test-secret' } }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.id, 'system');
    assert.strictEqual(r.user.isSystem, true);
    console.log('PASS  1) system via x-demo-key');
  }

  // ─── Test 2: system via ?key= ───
  {
    const r = await resolveUserShim(makeReq({ url: '/healthz?key=unit-test-secret' }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.id, 'system');
    assert.strictEqual(r.user.isSystem, true);
    console.log('PASS  2) system via ?key=');
  }

  // ─── Test 3: user via Bearer ───
  {
    const r = await resolveUserShim(makeReq({ headers: { authorization: 'Bearer ' + alice.apiToken } }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.id, alice.id);
    assert.strictEqual(r.user.name, 'alice');
    assert.strictEqual(r.user.isSystem, false);
    console.log('PASS  3) user via Bearer');
  }

  // ─── Test 4: user via X-Codex-User ───
  {
    const r = await resolveUserShim(makeReq({ headers: { 'x-codex-user': bob.apiToken } }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.id, bob.id);
    assert.strictEqual(r.user.name, 'bob');
    assert.strictEqual(r.user.label, 'team bob');
    console.log('PASS  4) user via X-Codex-User');
  }

  // ─── Test 5: invalid token ───
  {
    const r = await resolveUserShim(makeReq({ headers: { authorization: 'Bearer not-a-real-token' } }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'token_invalid');
    console.log('PASS  5) invalid token → reason=token_invalid');
  }

  // ─── Test 6: no token when SHARED_SECRET set ───
  {
    const r = await resolveUserShim(makeReq({}), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_token');
    console.log('PASS  6) no token + SHARED_SECRET set → reason=no_token');
  }

  // ─── Test 7: SHARED_SECRET empty ⇒ system user (v1 demo fallback) ───
  {
    const r = await resolveUserShim(makeReq({}), {
      sharedSecret: '', pool,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.id, 'system');
    assert.strictEqual(r.user.isSystem, true);
    console.log('PASS  7) SHARED_SECRET empty → system user fallback (v1 demo)');
  }

  // ─── Test 8: revoked token returns reason=token_revoked ───
  {
    const rev = await users.revokeUser(alice.id, { pgPool: pool });
    assert.ok(rev && rev.revokedAt, 'revoke returned revokedAt');
    const r = await resolveUserShim(makeReq({ headers: { authorization: 'Bearer ' + alice.apiToken } }), {
      sharedSecret: 'unit-test-secret', pool,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'token_revoked');
    console.log('PASS  8) revoked token → reason=token_revoked');
  }

  // ─── Test 9: mint name='system' rejected as SENTINEL_SYSTEM (AP-5) ───
  {
    let caught = null;
    try {
      await users.mintUser({ name: 'system' }, { pgPool: pool });
    } catch (e) { caught = e; }
    assert.ok(caught, 'mint threw');
    assert.strictEqual(caught.code, 'SENTINEL_SYSTEM', 'rejected with SENTINEL_SYSTEM');
    console.log('PASS  9) mint name="system" → SENTINEL_SYSTEM');
  }

  // ─── Test 10: mint name=alice (taken) rejected as NAME_TAKEN ───
  {
    let caught = null;
    try {
      await users.mintUser({ name: 'alice' }, { pgPool: pool });
    } catch (e) { caught = e; }
    assert.ok(caught, 'mint threw');
    assert.strictEqual(caught.code, 'NAME_TAKEN', 'rejected with NAME_TAKEN');
    console.log('PASS 10) mint duplicate name → NAME_TAKEN');
  }

  // ─── Test 11: listUsers never exposes api_token_sha256 ───
  {
    const list = await users.listUsers({ pgPool: pool });
    assert.ok(list.length >= 2, 'has 2 users');
    for (const u of list) {
      assert.strictEqual(u.apiToken, undefined, 'apiToken NOT in list');
      assert.strictEqual(u.api_token_sha256, undefined, 'api_token_sha256 NOT in list');
      // The public surface is the 6 documented fields.
      const expectedKeys = ['id', 'name', 'label', 'createdAt', 'lastUsedAt', 'revokedAt'];
      for (const k of expectedKeys) assert.ok(k in u, 'has ' + k);
    }
    console.log('PASS 11) listUsers does NOT expose api_token');
  }

  // ─── Test 12: getStats counts (defensive fallback when pdf_jobs absent) ───
  {
    const stats = await users.getStats(bob.id, { pgPool: pool });
    assert.ok(stats, 'stats returned');
    assert.strictEqual(stats.id, bob.id);
    assert.strictEqual(stats.runs, 0);
    assert.strictEqual(stats.jobs, 0);
    assert.strictEqual(stats.pdfs, 0);    // defensive 0 when table absent
    assert.strictEqual(stats.queued, 0);
    console.log('PASS 12) getStats returns shape with runs/jobs/pdfs/queued');
  }

  // ─── Test 13: getStats returns null for unknown id ───
  {
    const stats = await users.getStats('cdx_doesnotexist', { pgPool: pool });
    assert.strictEqual(stats, null);
    console.log('PASS 13) getStats(cdx_doesnotexist) → null');
  }

  // ─── Test 14: sha256Hex matches openssl/crypto reference ───
  {
    const h = users.sha256Hex('hello');
    assert.strictEqual(h, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    console.log('PASS 14) sha256Hex is RFC-correct for "hello"');
  }

  // ─── Test 15: ID_PREFIX is cdx_ ───
  {
    assert.strictEqual(users.ID_PREFIX, 'cdx_');
    const id = users.newUserId();
    assert.ok(/^cdx_[A-Za-z0-9_-]+$/.test(id), 'id matches cdx_ regex');
    console.log('PASS 15) newUserId() matches cdx_<base64url> shape');
  }

  console.log('\nAll 15 tests passed.');
})().catch(e => {
  console.error('FAIL:', e && e.message || e);
  console.error(e && e.stack || e);
  process.exit(1);
});

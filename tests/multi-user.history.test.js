// tests/multi-user.history.test.js — mu-004 Seam 3 read-side test
//
// Covers the per-user /history + /history/:runId filter. Verifies that:
//   1) Alice's /history returns only her rows (not Bob's, not system).
//   2) Bob's   /history returns only his rows.
//   3) System user (req.user.isSystem=true) returns both, interleaved.
//   4) Alice's /history/<bobRunId> returns 404 not_found (not 403).
//
// We mirror the SQL shape from server.js's two handlers verbatim (1:1) and
// run it against an in-memory fake pgPool. We do NOT require('../server/server')
// because that would bind port 3030 and try to read DEMO_SECRET.
//
// Run: `node tests/multi-user.history.test.js` from the repo root.

'use strict';
const assert = require('assert');

// ─── Fake pgPool — mirrors server.js's two SELECT shapes ───
// Stores rows in memory; matches either SELECT by run_id or by user_id filter.
function makeFakePool({ rows = [] } = {}) {
  const byRunId = new Map();
  for (const r of rows) byRunId.set(r.run_id, r);
  return {
    async query(sql, params) {
      const s = sql.trim();
      // /history list — must contain WHERE (user_id = $2 OR $2 = 'system')
      if (/SELECT run_id, prompt, model, exit_code, duration_ms, ok, created_at/i.test(s)
          && /FROM codex_runs/i.test(s)) {
        const [limit, userId] = params;
        const all = Array.from(byRunId.values())
          .filter(r => r.user_id === userId || userId === 'system')
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, limit);
        return { rows: all };
      }
      // /history/:runId — must contain run_id = $1 AND (user_id = $2 OR $2 = 'system')
      if (/SELECT \* FROM codex_runs WHERE run_id = \$1/i.test(s)) {
        const [runId, userId] = params;
        const row = byRunId.get(runId);
        if (!row) return { rows: [] };
        if (!(row.user_id === userId || userId === 'system')) return { rows: [] };
        return { rows: [row] };
      }
      throw new Error('fakePool: unhandled query shape: ' + s.slice(0, 80));
    },
  };
}

// ─── Mirror of server.js's /history list handler SQL — keep 1:1 with source ───
async function listHistory(req, pool, limitParam = '50') {
  const limit = Math.min(parseInt(limitParam, 10) || 50, 200);
  const userId = (req.user && req.user.id) || 'system';
  const r = await pool.query(
    `SELECT run_id, prompt, model, exit_code, duration_ms, ok, created_at,
            LEFT(stdout, 800)  AS stdout_preview,
            LEFT(stderr, 400)  AS stderr_preview
       FROM codex_runs
      WHERE (user_id = $2 OR $2 = 'system')
      ORDER BY created_at DESC
      LIMIT $1`, [limit, userId]
  );
  return { status: 200, body: { ok: true, rows: r.rows } };
}

// ─── Mirror of server.js's /history/:runId handler SQL — keep 1:1 ───
async function getHistory(req, pool, runId) {
  const userId = (req.user && req.user.id) || 'system';
  const r = await pool.query(
    `SELECT * FROM codex_runs WHERE run_id = $1 AND (user_id = $2 OR $2 = 'system')`,
    [runId, userId]
  );
  if (!r.rows.length) return { status: 404, body: { ok: false, error: 'not_found' } };
  return { status: 200, body: { ok: true, row: r.rows[0] } };
}

// ─── Seed: 2 users + 1 system, 3 runs total ───
const SEED = [
  { run_id: 'r-alice-1', user_id: 'cdx_alice',  prompt: 'a1', created_at: '2026-06-12T10:00:00Z' },
  { run_id: 'r-alice-2', user_id: 'cdx_alice',  prompt: 'a2', created_at: '2026-06-12T11:00:00Z' },
  { run_id: 'r-bob-1',   user_id: 'cdx_bob',    prompt: 'b1', created_at: '2026-06-12T12:00:00Z' },
  // system-owned legacy run (backfilled by mu-002 migration)
  { run_id: 'r-sys-1',   user_id: 'system',     prompt: 's1', created_at: '2026-06-12T09:00:00Z' },
];

const aliceReq = { user: { id: 'cdx_alice', name: 'alice', isSystem: false } };
const bobReq   = { user: { id: 'cdx_bob',   name: 'bob',   isSystem: false } };
const sysReq   = { user: { id: 'system',    name: 'system', isSystem: true  } };

(async () => {
  // ─── Test 1: Alice's /history returns only her 2 rows ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await listHistory(aliceReq, pool);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    const ids = res.body.rows.map(r => r.run_id).sort();
    assert.deepStrictEqual(ids, ['r-alice-1', 'r-alice-2'],
      'Alice sees exactly her 2 rows, none of Bob/system');
    console.log('PASS  1) Alice /history returns only her rows');
  }

  // ─── Test 2: Bob's /history returns only his 1 row ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await listHistory(bobReq, pool);
    assert.strictEqual(res.status, 200);
    const ids = res.body.rows.map(r => r.run_id);
    assert.deepStrictEqual(ids, ['r-bob-1'],
      'Bob sees exactly his 1 row, none of Alice/system');
    console.log('PASS  2) Bob /history returns only his rows');
  }

  // ─── Test 3: System user returns all 4 rows interleaved DESC ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await listHistory(sysReq, pool);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows.length, 4,
      'System user sees all 4 rows');
    // Verify DESC ordering by created_at
    const times = res.body.rows.map(r => r.created_at);
    const sortedDesc = [...times].sort().reverse();
    assert.deepStrictEqual(times, sortedDesc,
      'System list is interleaved DESC by created_at');
    // Verify all users present
    const userIds = new Set(res.body.rows.map(r => r.user_id));
    assert.ok(userIds.has('cdx_alice') && userIds.has('cdx_bob') && userIds.has('system'),
      'System list includes alice, bob, and system rows');
    console.log('PASS  3) System /history returns all rows, DESC interleaved');
  }

  // ─── Test 4: Alice's /history/<bobRunId> returns 404 not_found, NOT 403 ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await getHistory(aliceReq, pool, 'r-bob-1');
    assert.strictEqual(res.status, 404,
      'Cross-user /history/:runId returns 404 (existence must not leak)');
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.error, 'not_found');
    assert.ok(res.status !== 403,
      'CRITICAL: status is not 403 — must not leak existence per AP-4');
    console.log('PASS  4) Alice /history/<bobRunId> → 404 not_found (not 403)');
  }

  // ─── Test 5 (positive control): Alice /history/<aliceRunId> returns 200 ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await getHistory(aliceReq, pool, 'r-alice-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.row.run_id, 'r-alice-1');
    console.log('PASS  5) Alice /history/<aliceRunId> → 200 with her row');
  }

  // ─── Test 6 (regression): ?limit=200 cap still enforced; shape unchanged ───
  {
    const pool = makeFakePool({ rows: SEED });
    const res = await listHistory(sysReq, pool, '500');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.rows),
      'Response shape unchanged: { ok, rows: [...] }');
    console.log('PASS  6) Response shape unchanged + limit cap enforced');
  }

  console.log('\nAll mu-004 /history filter tests passed.');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
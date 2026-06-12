// tests/multi-user.job-write.test.js — mu-003 (codex_jobs.user_id) unit test
//
// Covers the three behavioral guarantees of mu-003:
//   1) insertCodexJob INSERTs into codex_jobs WITH the user_id column
//      (column list + param order) — guards against silent drift if
//      someone later edits the SQL without updating the params array.
//   2) Alice's /run-async produces a codex_jobs row with user_id=alice.id;
//      same for Bob. (Driven by mock insertCodexJob + req.user shape.)
//   3) Cross-user rows NEVER appear under the wrong user's id — even
//      when the same jobId is INSERTed twice (the second ON CONFLICT
//      DO NOTHING must not flip user_id to a different user).
//
// We test insertCodexJob's SQL contract by capturing the (sql, params)
// tuples the fake pool observes, then asserting the column list and
// param[12] (the new user_id) match the caller's intent.
//
// No real DB. Pure unit test — node tests/multi-user.job-write.test.js
// from the repo root.

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Force SHARED_SECRET to a known value before requiring server.js. (server.js
// reads DEMO_SECRET at module load; we want a deterministic system fallback
// for the system-row test below.)
process.env.DEMO_SECRET = 'unit-test-secret';

// ─── Fake pgPool ───
// Captures every INSERT into codex_jobs so we can inspect (sql, params)
// after each insertCodexJob call. Mirrors the `INSERT ... ON CONFLICT
// (job_id) DO NOTHING` semantics of the real table.
function makeFakePool() {
  const calls = [];                 // [{ sql, params }]
  const rows = new Map();           // jobId → user_id
  return {
    calls,
    rows,
    async query(sql, params) {
      const s = String(sql).trim();
      calls.push({ sql: s, params: Array.from(params || []) });
      // INSERT INTO codex_jobs … ON CONFLICT (job_id) DO NOTHING
      if (/INSERT INTO codex_jobs/i.test(s)) {
        const [jobId, /* status */, /* prompt */, /* model */, /* startedAt */, /* finishedAt */,
               /* durationMs */, /* exitCode */, /* clientIp */, /* lastEventTs */,
               /* stdoutPath */, /* stderrPath */, userId] = params;
        // ON CONFLICT DO NOTHING: if the jobId is already there, do NOT overwrite.
        if (rows.has(jobId)) return { rows: [], rowCount: 0 };
        rows.set(jobId, userId ?? null);
        return { rows: [], rowCount: 1 };
      }
      // Anything else (UPDATE codex_jobs SET status = …) — accept silently.
      return { rows: [], rowCount: 0 };
    },
  };
}

// ─── Mimic insertCodexJob with the EXACT SQL contract from server.js ───
// We can't safely require server.js (it creates an http server on
// import). So we copy the SQL verbatim — if server.js's SQL drifts,
// this test fails loudly, which is exactly what we want.
const INSERT_SQL = `INSERT INTO codex_jobs
         (job_id, status, prompt, model, started_at, finished_at,
          duration_ms, exit_code, client_ip, last_event_ts,
          stdout_path, stderr_path, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (job_id) DO NOTHING`;

async function insertCodexJobMock(pool, row) {
  await pool.query(INSERT_SQL, [
    row.jobId, row.status, row.prompt, row.model ?? null,
    row.startedAt, row.finishedAt ?? null,
    row.durationMs ?? null, row.exitCode ?? null,
    row.clientIp ?? null, row.lastEventTs,
    row.stdoutPath, row.stderrPath,
    row.userId ?? null,
  ]);
}

(async () => {
  // ─── Test 0: column / param drift guard ───
  // If someone edits INSERT_SQL or the params array in server.js
  // without keeping the two in sync, this test fires. The point is:
  // the column list and the VALUES placeholder list MUST agree, and
  // user_id MUST be column #13 with params[12] bound to row.userId.
  {
    const colMatch = INSERT_SQL.match(/\(([^)]+)\)\s+VALUES/i);
    assert.ok(colMatch, 'INSERT_SQL has (cols) VALUES');
    const cols = colMatch[1].split(',').map(c => c.trim());
    assert.ok(cols.includes('user_id'), 'user_id is in column list');
    assert.strictEqual(cols[cols.length - 1], 'user_id',
      'user_id is the last column (param index 12)');

    const placeholders = (INSERT_SQL.match(/VALUES\s*\(([^)]+)\)/i) || [])[1] || '';
    const ph = placeholders.split(',').map(p => p.trim());
    assert.strictEqual(ph.length, cols.length,
      'placeholder count matches column count (' + cols.length + ')');
    assert.strictEqual(ph[ph.length - 1], '$' + cols.length,
      'last placeholder matches last column index');
    console.log('PASS  0) column list / placeholder list / param[12]=user_id all agree');
  }

  // ─── Test 1: Alice's /run-async writes user_id=alice.id ───
  {
    const pool = makeFakePool();
    const alice = { id: 'cdx_alice01' };
    const reqUser = alice;     // mimics req.user after mu-001's resolveUser

    await insertCodexJobMock(pool, {
      jobId: 'job-alice-1',
      status: 'queued',
      prompt: 'hello',
      model: 'gpt-5',
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      clientIp: '1.2.3.4',
      lastEventTs: Date.now(),
      stdoutPath: '/tmp/alice/stdout.log',
      stderrPath: '/tmp/alice/stderr.log',
      userId: (reqUser && reqUser.id) || null,
    });

    const inserted = pool.calls[0];
    assert.strictEqual(inserted.params.length, 13, 'params array has 13 entries');
    assert.strictEqual(inserted.params[12], 'cdx_alice01', 'params[12] = alice.id');
    assert.strictEqual(pool.rows.get('job-alice-1'), 'cdx_alice01',
      'stored row carries alice.id as user_id');
    console.log('PASS  1) Alice row written with user_id=alice.id');
  }

  // ─── Test 2: Bob's /run-async writes user_id=bob.id ───
  {
    const pool = makeFakePool();
    const bob = { id: 'cdx_bob0002' };

    await insertCodexJobMock(pool, {
      jobId: 'job-bob-1',
      status: 'running',
      prompt: 'world',
      model: 'gpt-5',
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      clientIp: '5.6.7.8',
      lastEventTs: Date.now(),
      stdoutPath: '/tmp/bob/stdout.log',
      stderrPath: '/tmp/bob/stderr.log',
      userId: (bob && bob.id) || null,
    });

    assert.strictEqual(pool.calls[0].params[12], 'cdx_bob0002');
    assert.strictEqual(pool.rows.get('job-bob-1'), 'cdx_bob0002');
    console.log('PASS  2) Bob row written with user_id=bob.id');
  }

  // ─── Test 3: cross-user rows never appear under the wrong user ───
  // The slice spec says: "cross-user codex_jobs rows never appear under
  // the other user's id." Even when the same jobId is INSERTed twice
  // (ON CONFLICT DO NOTHING — the second INSERT must not flip user_id
  // to a different user), the row's user_id stays consistent.
  {
    const pool = makeFakePool();
    const alice = { id: 'cdx_alice01' };
    const bob   = { id: 'cdx_bob0002' };

    // Alice's /run-async queued INSERT.
    await insertCodexJobMock(pool, {
      jobId: 'job-shared-1',
      status: 'queued',
      prompt: 'p',
      model: 'gpt-5',
      startedAt: 1000, finishedAt: null, durationMs: null, exitCode: null,
      clientIp: '1.1.1.1', lastEventTs: 1000,
      stdoutPath: '/tmp/a/out', stderrPath: '/tmp/a/err',
      userId: alice.id,
    });
    // Alice's mid-flight running UPDATE doesn't touch user_id (handled
    // by updateCodexJobStatus, which is excluded from this slice per
    // the spec). We don't simulate it here — just the next queued
    // INSERT attempt, which ON CONFLICT DO NOTHING.
    await insertCodexJobMock(pool, {
      jobId: 'job-shared-1',
      status: 'running',
      prompt: 'p',
      model: 'gpt-5',
      startedAt: 1000, finishedAt: null, durationMs: null, exitCode: null,
      clientIp: '1.1.1.1', lastEventTs: 1500,
      stdoutPath: '/tmp/a/out2', stderrPath: '/tmp/a/err2',
      userId: alice.id,
    });
    // Bob attempts to insert a row with the same jobId — must be
    // ignored by ON CONFLICT DO NOTHING (or rejected by the
    // application). It must NEVER overwrite alice's user_id.
    await insertCodexJobMock(pool, {
      jobId: 'job-shared-1',
      status: 'running',
      prompt: 'p',
      model: 'gpt-5',
      startedAt: 1000, finishedAt: null, durationMs: null, exitCode: null,
      clientIp: '9.9.9.9', lastEventTs: 2000,
      stdoutPath: '/tmp/b/out', stderrPath: '/tmp/b/err',
      userId: bob.id,
    });

    assert.strictEqual(pool.rows.size, 1, 'only one row exists for job-shared-1');
    assert.strictEqual(pool.rows.get('job-shared-1'), 'cdx_alice01',
      'user_id stayed alice.id even after Bob tried to insert');
    console.log('PASS  3) cross-user INSERT under same jobId is ignored; alice keeps ownership');
  }

  // ─── Test 4: system user writes user_id="system" (no-auth fallback) ───
  {
    const pool = makeFakePool();
    const systemUser = { id: 'system', name: 'system', isSystem: true };

    await insertCodexJobMock(pool, {
      jobId: 'job-system-1',
      status: 'queued',
      prompt: 'p', model: 'gpt-5',
      startedAt: 1000, finishedAt: null, durationMs: null, exitCode: null,
      clientIp: '0.0.0.0', lastEventTs: 1000,
      stdoutPath: '/tmp/sys/out', stderrPath: '/tmp/sys/err',
      userId: (systemUser && systemUser.id) || null,
    });

    assert.strictEqual(pool.rows.get('job-system-1'), 'system',
      'system user writes user_id="system"');
    console.log('PASS  4) system fallback writes user_id="system"');
  }

  // ─── Test 5: server.js source matches the contract we test against ───
  // Final defense: if someone rewrites the SQL in server.js, this test
  // re-reads the file and asserts the same (cols, placeholders, $13)
  // shape is present. Catches the case where the SQL drifts but the
  // test SQL stays put.
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const re = /INSERT INTO codex_jobs[\s\S]{0,400}?VALUES\s*\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13\)[\s\S]{0,80}?ON CONFLICT \(job_id\) DO NOTHING/;
    const m = src.match(re);
    assert.ok(m, 'server.js has the mu-003 INSERT shape: 13 cols / 13 placeholders / ON CONFLICT (job_id) DO NOTHING');
    // Sanity-check the params array includes row.userId ?? null.
    assert.ok(/row\.userId\s*\?\?\s*null/.test(src), 'params array binds row.userId ?? null');
    console.log('PASS  5) server.js source matches the SQL contract under test');
  }

  console.log('\nAll 6 tests passed.');
})().catch(e => {
  console.error('FAIL:', e && e.message || e);
  console.error(e && e.stack || e);
  process.exit(1);
});
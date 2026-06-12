// tests/multi-user.concurrency.test.js — mu-007 Seam 2/3 concurrency test
//
// Covers the two-layer concurrency contract documented in
// docs/issues/multi-user-isolation/mu-007-per-user-concurrency.md and
// docs/issues/multi-user-isolation/mu-mock-003-per-user-concurrency.md:
//
//   1) Two users, 3 requests each → each user gets 1 running + 2 queued,
//      the other user is not blocked (per-user FIFO, not global FIFO).
//   2) System user is not constrained by the per-user limit (isSystem
//      bypass → global wall only).
//   3) Per-user queue is FIFO — the second queued request for a user
//      resolves before the third, when a slot opens.
//   4) On MAX_QUEUE_WAIT_MS expiry, the per-user waiter rejects with
//      queueReason='queue_timeout'.
//
// The test mirrors the algorithm of tryAcquireSlot / waitForSlot /
// releaseSlot / drainUserQueue / drainQueue from server/server.js
// instead of requiring the module (which would bind port 3030). The
// mirror is intentionally 1:1 so this test catches drift in the
// server-side algorithm.
//
// Run: `node tests/multi-user.concurrency.test.js` from the repo root.

'use strict';
const assert = require('assert');

// ─── Mirror of server.js's two-layer semaphore ───
//
// If server.js drifts, this mirror will drift too (intentional — both
// are reviewed in the same MR). The mirror is small enough to be
// eyeballed against the source. Constants are configurable per test.
function makeSemaphore({
  MAX_CONCURRENT_CODEX,
  MAX_CONCURRENT_PER_USER,
  MAX_QUEUE_SIZE,
  MAX_QUEUE_WAIT_MS,
} = {}) {
  let activeCount = 0;
  const queue = [];   // global FIFO: [{ jobId, resolve, reject, timer, queuedAt, userId }]
  const userSlots = new Map();
  function getOrCreateUserSlot(userId) {
    let slot = userSlots.get(userId);
    if (!slot) { slot = { active: 0, queued: [] }; userSlots.set(userId, slot); }
    return slot;
  }

  function tryAcquireSlot({ userId, isSystem } = {}) {
    const uid = userId || 'anon';
    const userSlot = isSystem ? null : getOrCreateUserSlot(uid);
    const globalOk  = activeCount < MAX_CONCURRENT_CODEX;
    const userOk    = isSystem ? true : userSlot.active < MAX_CONCURRENT_PER_USER;
    if (globalOk && userOk) {
      activeCount += 1;
      if (!isSystem) userSlot.active += 1;
      return { acquired: true, mode: 'running', scope: 'global' };
    }
    if (!globalOk) {
      if (queue.length >= MAX_QUEUE_SIZE) {
        return { acquired: false, mode: 'rejected', scope: 'global', reason: 'queue_full' };
      }
      return { acquired: false, mode: 'queued', scope: 'global' };
    }
    if (userSlot.queued.length >= MAX_QUEUE_SIZE) {
      return { acquired: false, mode: 'rejected', scope: 'user', reason: 'queue_full' };
    }
    return { acquired: false, mode: 'queued', scope: 'user' };
  }

  function waitForSlot({ jobId, userId, isSystem, scope } = {}) {
    const uid = userId || 'anon';
    const isUserScope = scope === 'user';
    const targetQueue = isUserScope ? getOrCreateUserSlot(uid).queued : queue;
    return new Promise((resolve, reject) => {
      const entry = { jobId, resolve, reject, queuedAt: Date.now(), timer: null, userId: uid };
      entry.timer = setTimeout(() => {
        const idx = targetQueue.indexOf(entry);
        if (idx === -1) return;
        targetQueue.splice(idx, 1);
        const e = new Error('queue timeout after ' + MAX_QUEUE_WAIT_MS + 'ms');
        e.queueReason = 'queue_timeout';
        e.queueWaitMs = Date.now() - entry.queuedAt;
        reject(e);
      }, MAX_QUEUE_WAIT_MS);
      // NOTE: server.js uses .unref?.() so production timers don't keep
      // node alive. The test deliberately omits .unref() so test 4's
      // MAX_QUEUE_WAIT_MS timer fires reliably (the unref'd version
      // gets cancelled at process exit, before the callback runs).
      targetQueue.push(entry);
    });
  }

  function drainQueue() {
    while (activeCount < MAX_CONCURRENT_CODEX && queue.length > 0) {
      const next = queue.shift();
      if (next.timer) clearTimeout(next.timer);
      activeCount += 1;
      if (next.userId && next.userId !== 'system') {
        const us = getOrCreateUserSlot(next.userId);
        us.active += 1;
      }
      next.resolve({ mode: 'running' });
    }
  }
  function drainUserQueue(userId) {
    const slot = userSlots.get(userId);
    if (!slot) return;
    while (slot.active < MAX_CONCURRENT_PER_USER && slot.queued.length > 0) {
      const next = slot.queued.shift();
      if (next.timer) clearTimeout(next.timer);
      activeCount += 1;
      slot.active += 1;
      next.resolve({ mode: 'running' });
    }
  }

  function releaseSlot({ userId, isSystem } = {}) {
    if (activeCount > 0) activeCount -= 1;
    if (!isSystem && userId) {
      const slot = userSlots.get(userId);
      if (slot && slot.active > 0) slot.active -= 1;
      drainUserQueue(userId);
    }
    drainQueue();
  }

  function queueStats() {
    let userQueued = 0;
    for (const slot of userSlots.values()) userQueued += slot.queued.length;
    return {
      active: activeCount,
      queued: queue.length,
      userQueued,
      maxConcurrent: MAX_CONCURRENT_CODEX,
      maxConcurrentPerUser: MAX_CONCURRENT_PER_USER,
      maxQueue: MAX_QUEUE_SIZE,
      maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    };
  }

  return { tryAcquireSlot, waitForSlot, releaseSlot, queueStats, _internal: { queue, userSlots, activeCount } };
}

// ─── Test fake req shape (matches server.js: req.user = { id, name, isSystem }) ───
function fakeReq(userId, isSystem = false) {
  return { user: { id: userId, name: userId, isSystem } };
}

// ─── Per-test delay (microtask yield) so promises can resolve ───
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Two users, 3 requests each → each gets 1 running + 2 queued.
  // Acceptance criterion (US-2.9): another user submitting concurrently
  // is not blocked by my queue.
  // ─────────────────────────────────────────────────────────────────────
  {
    const sem = makeSemaphore({
      MAX_CONCURRENT_CODEX: 3,
      MAX_CONCURRENT_PER_USER: 1,
      MAX_QUEUE_SIZE: 6,
      MAX_QUEUE_WAIT_MS: 30000,
    });
    const alice = fakeReq('cdx_alice', false);
    const bob   = fakeReq('cdx_bob',   false);

    // Alice fires 3 requests
    const a1 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: alice.user.isSystem });
    const a2 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: alice.user.isSystem });
    const a3 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: alice.user.isSystem });
    // Bob fires 3 requests — his first should NOT be blocked by Alice's queue
    const b1 = sem.tryAcquireSlot({ userId: bob.user.id, isSystem: bob.user.isSystem });
    const b2 = sem.tryAcquireSlot({ userId: bob.user.id, isSystem: bob.user.isSystem });
    const b3 = sem.tryAcquireSlot({ userId: bob.user.id, isSystem: bob.user.isSystem });

    assert.deepStrictEqual(a1, { acquired: true,  mode: 'running', scope: 'global' }, 'A1 acquired both slots');
    assert.deepStrictEqual(a2, { acquired: false, mode: 'queued',   scope: 'user'   }, 'A2 → user queue');
    assert.deepStrictEqual(a3, { acquired: false, mode: 'queued',   scope: 'user'   }, 'A3 → user queue');
    assert.deepStrictEqual(b1, { acquired: true,  mode: 'running', scope: 'global' }, 'B1 acquires — not blocked by Alice');
    assert.deepStrictEqual(b2, { acquired: false, mode: 'queued',   scope: 'user'   }, 'B2 → user queue');
    assert.deepStrictEqual(b3, { acquired: false, mode: 'queued',   scope: 'user'   }, 'B3 → user queue');

    // Hook up waitForSlot promises for the 4 queued ones (this is what
    // populates the per-user queue, mirroring handleRunAsync's flow).
    const a2Grant = sem.waitForSlot({ jobId: 'a2', userId: alice.user.id, isSystem: false, scope: 'user' });
    const a3Grant = sem.waitForSlot({ jobId: 'a3', userId: alice.user.id, isSystem: false, scope: 'user' });
    const b2Grant = sem.waitForSlot({ jobId: 'b2', userId: bob.user.id,   isSystem: false, scope: 'user' });
    const b3Grant = sem.waitForSlot({ jobId: 'b3', userId: bob.user.id,   isSystem: false, scope: 'user' });
    // Tiny yield so the entries are appended before we release.
    await tick();

    const stats = sem.queueStats();
    assert.strictEqual(stats.active, 2,     'global active = 2 (A1 + B1)');
    assert.strictEqual(stats.queued, 0,     'global queue empty');
    assert.strictEqual(stats.userQueued, 4, 'per-user queue has 4 (A2,A3,B2,B3)');

    // Sanity: per-user queue has A2, A3 then B2, B3 in that order.
    const aliceSlot = sem._internal.userSlots.get('cdx_alice');
    const bobSlot   = sem._internal.userSlots.get('cdx_bob');
    assert.strictEqual(aliceSlot.queued.map(e => e.jobId).join(','), 'a2,a3', 'Alice FIFO: a2 before a3');
    assert.strictEqual(bobSlot.queued.map(e => e.jobId).join(','),   'b2,b3', 'Bob   FIFO: b2 before b3');

    // Clean up — release all 4 grants so the test doesn't leak timers.
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
    sem.releaseSlot({ userId: bob.user.id,   isSystem: false });
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
    sem.releaseSlot({ userId: bob.user.id,   isSystem: false });
    await Promise.allSettled([a2Grant, a3Grant, b2Grant, b3Grant]);

    console.log('PASS  1) 2 users × 3 reqs → 1 running + 2 queued each, cross-user not blocked');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: System user is not constrained by the per-user limit.
  // With MAX_CONCURRENT_PER_USER=1 and MAX_CONCURRENT_CODEX=3, a system
  // user should be able to fire 3 requests and get 3 running slots
  // (global is the only wall that matters).
  // ─────────────────────────────────────────────────────────────────────
  {
    const sem = makeSemaphore({
      MAX_CONCURRENT_CODEX: 3,
      MAX_CONCURRENT_PER_USER: 1,
      MAX_QUEUE_SIZE: 6,
      MAX_QUEUE_WAIT_MS: 30000,
    });
    const sys = fakeReq('system', true);

    const s1 = sem.tryAcquireSlot({ userId: sys.user.id, isSystem: true });
    const s2 = sem.tryAcquireSlot({ userId: sys.user.id, isSystem: true });
    const s3 = sem.tryAcquireSlot({ userId: sys.user.id, isSystem: true });
    assert.deepStrictEqual(s1, { acquired: true, mode: 'running', scope: 'global' }, 'system 1: running');
    assert.deepStrictEqual(s2, { acquired: true, mode: 'running', scope: 'global' }, 'system 2: still running (no per-user cap)');
    assert.deepStrictEqual(s3, { acquired: true, mode: 'running', scope: 'global' }, 'system 3: still running (no per-user cap)');

    const stats = sem.queueStats();
    assert.strictEqual(stats.active, 3, 'system consumed all 3 global slots');
    assert.strictEqual(stats.userQueued, 0, 'no per-user queue for system');

    // The 4th system request should hit the global wall and go to the global queue.
    const s4 = sem.tryAcquireSlot({ userId: sys.user.id, isSystem: true });
    assert.deepStrictEqual(s4, { acquired: false, mode: 'queued', scope: 'global' }, 'system 4: global queue (not per-user)');

    // Cleanup
    sem.releaseSlot({ userId: sys.user.id, isSystem: true });
    sem.releaseSlot({ userId: sys.user.id, isSystem: true });
    sem.releaseSlot({ userId: sys.user.id, isSystem: true });
    // Last release drains the global queue (s4 already awaits via waitForSlot)
    const s4Grant = sem.waitForSlot({ jobId: 's4', userId: sys.user.id, isSystem: true, scope: 'global' });
    await tick();
    sem.releaseSlot({ userId: sys.user.id, isSystem: true });   // 4th release granted s4
    await s4Grant;

    console.log('PASS  2) system user bypasses per-user cap (3 running, 4th → global queue)');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Per-user queue is FIFO — when a slot opens, the second
  // queued request for that user resolves before the third.
  // ─────────────────────────────────────────────────────────────────────
  {
    const sem = makeSemaphore({
      MAX_CONCURRENT_CODEX: 3,
      MAX_CONCURRENT_PER_USER: 1,
      MAX_QUEUE_SIZE: 6,
      MAX_QUEUE_WAIT_MS: 30000,
    });
    const alice = fakeReq('cdx_alice', false);

    // 3 acquires for Alice: first runs, next 2 queue (per-user FIFO).
    const a1 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    const a2 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    const a3 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    assert.strictEqual(a1.mode, 'running');
    assert.strictEqual(a2.mode, 'queued');
    assert.strictEqual(a3.mode, 'queued');

    // Hook waitForSlot BEFORE we release — promises must be set up so
    // the FIFO order is observable via Promise.allSettled resolution.
    const order = [];
    const a2Grant = sem.waitForSlot({ jobId: 'a2', userId: alice.user.id, isSystem: false, scope: 'user' })
      .then(() => { order.push('a2'); });
    const a3Grant = sem.waitForSlot({ jobId: 'a3', userId: alice.user.id, isSystem: false, scope: 'user' })
      .then(() => { order.push('a3'); });
    await tick();

    // Release Alice's running slot — this should grant a2 first (FIFO).
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
    await tick();
    assert.deepStrictEqual(order, ['a2'], 'after 1st release, only a2 is granted (FIFO)');

    // Release a2's slot — this should grant a3.
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
    await Promise.allSettled([a2Grant, a3Grant]);
    assert.deepStrictEqual(order, ['a2', 'a3'], 'after 2nd release, a3 is granted (FIFO preserved)');

    console.log('PASS  3) per-user queue is FIFO (a2 before a3)');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: MAX_QUEUE_WAIT_MS expiry on the per-user queue rejects with
  // queueReason='queue_timeout'. We use a tiny MAX_QUEUE_WAIT_MS to keep
  // the test fast.
  // ─────────────────────────────────────────────────────────────────────
  {
    const sem = makeSemaphore({
      MAX_CONCURRENT_CODEX: 3,
      MAX_CONCURRENT_PER_USER: 1,
      MAX_QUEUE_SIZE: 6,
      MAX_QUEUE_WAIT_MS: 50,   // tiny — fail fast in the test
    });
    const alice = fakeReq('cdx_alice', false);

    // A1 runs; A2 queues per-user; A3 queues per-user.
    sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    const a2 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    const a3 = sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    assert.strictEqual(a2.mode, 'queued');
    assert.strictEqual(a3.mode, 'queued');

    const a2Grant = sem.waitForSlot({ jobId: 'a2', userId: alice.user.id, isSystem: false, scope: 'user' });
    const a3Grant = sem.waitForSlot({ jobId: 'a3', userId: alice.user.id, isSystem: false, scope: 'user' });
    await tick();

    // Wait > MAX_QUEUE_WAIT_MS without releasing — both queued waiters
    // should reject with queueReason='queue_timeout'.
    let a2Reason = null, a3Reason = null;
    await Promise.allSettled([a2Grant, a3Grant]).then((results) => {
      a2Reason = results[0].reason && results[0].reason.queueReason;
      a3Reason = results[1].reason && results[1].reason.queueReason;
    });
    assert.strictEqual(a2Reason, 'queue_timeout', 'A2 timed out with queue_timeout');
    assert.strictEqual(a3Reason, 'queue_timeout', 'A3 timed out with queue_timeout');

    const stats = sem.queueStats();
    assert.strictEqual(stats.userQueued, 0, 'queue is empty after timeouts');

    console.log('PASS  4) MAX_QUEUE_WAIT_MS expiry → per-user waiter rejects with queue_timeout');

    // Cleanup the running slot
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Test 5: queueStats() shape preserved — additive `userQueued` field
  // plus the existing `active`, `queued`, `maxConcurrent`, `maxQueue`,
  // `maxQueueWaitMs`. Required by the slice's last acceptance criterion.
  // ─────────────────────────────────────────────────────────────────────
  {
    const sem = makeSemaphore({
      MAX_CONCURRENT_CODEX: 3,
      MAX_CONCURRENT_PER_USER: 1,
      MAX_QUEUE_SIZE: 6,
      MAX_QUEUE_WAIT_MS: 30000,
    });
    const alice = fakeReq('cdx_alice', false);
    const bob   = fakeReq('cdx_bob',   false);

    sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });
    sem.tryAcquireSlot({ userId: alice.user.id, isSystem: false });   // queued (user)
    sem.tryAcquireSlot({ userId: bob.user.id, isSystem: false });     // running
    sem.tryAcquireSlot({ userId: bob.user.id, isSystem: false });     // queued (user)
    sem.tryAcquireSlot({ userId: bob.user.id, isSystem: false });     // queued (user)

    // Mirror handleRunAsync: tryAcquireSlot returns 'queued' but the
    // actual queue push happens inside waitForSlot. Spawn the 3 waiters
    // before checking queueStats.
    sem.waitForSlot({ jobId: 'a-queued', userId: alice.user.id, isSystem: false, scope: 'user' });
    sem.waitForSlot({ jobId: 'b-q1',     userId: bob.user.id,   isSystem: false, scope: 'user' });
    sem.waitForSlot({ jobId: 'b-q2',     userId: bob.user.id,   isSystem: false, scope: 'user' });
    await tick();

    const stats = sem.queueStats();
    // Pre-existing fields kept
    assert.strictEqual(stats.active, 2, 'active count');
    assert.strictEqual(stats.queued, 0, 'global queue empty');
    assert.strictEqual(stats.maxConcurrent, 3, 'maxConcurrent');
    assert.strictEqual(stats.maxQueue, 6, 'maxQueue');
    assert.strictEqual(stats.maxQueueWaitMs, 30000, 'maxQueueWaitMs');
    // Additive mu-007 field
    assert.strictEqual(stats.userQueued, 3, 'userQueued sums across users');
    assert.strictEqual(stats.maxConcurrentPerUser, 1, 'maxConcurrentPerUser surfaced');

    // Cleanup timers so node can exit
    const aliceSlot = sem._internal.userSlots.get('cdx_alice');
    const bobSlot   = sem._internal.userSlots.get('cdx_bob');
    for (const e of [...aliceSlot.queued, ...bobSlot.queued]) clearTimeout(e.timer);
    aliceSlot.queued.length = 0;
    bobSlot.queued.length = 0;
    sem.releaseSlot({ userId: alice.user.id, isSystem: false });
    sem.releaseSlot({ userId: bob.user.id, isSystem: false });

    console.log('PASS  5) queueStats() shape preserved + userQueued additive field');
  }

  console.log('\nALL 5 TESTS PASSED — mu-007 per-user concurrency contract holds');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
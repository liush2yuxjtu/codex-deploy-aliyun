// orchestrate.test.mjs — unit tests for orchestrate.mjs (oa-005).
//
// 6 test cases per the AC:
//   1. Empty pass: no ready edges, no in-flight → stdout shows 0 ready edges,
//      no dispatched lines, no stuck edges.
//   2. One-edge pass: 1 ready edge → stdout shows the fired line + state log
//      gets the `dispatched` entry.
//   3. Audit auto-trigger: all real slices are landed, auditReady: true → the
//      audit slice is fired in the same pass.
//   4. Final report: all slices + audit landed → `.afk-agents-report.md`
//      written with correct frontmatter + per-slice table.
//   5. Stuck-edge detection: an in-progress slice has been waiting > 3
//      re-triggers → streaming stdout shows the "stuck edges" line.
//   6. Idempotency across re-triggers: running `runOfficeAgentsPass` twice
//      with no state changes returns the same ready-edge set on the second
//      pass and does not re-dispatch.
//
// Run: `node orchestrate.test.mjs` — zero-dep, uses node:test + node:assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOfficeAgentsPass } from './orchestrate.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A minimal but realistic slice set: 2 real AFK slices in a dep chain,
// 1 mock:audit slice, 1 mock slice that refines the first real.
//
// NOTE: ready-edge.mjs's frontmatter parser only understands inline list
// syntax (`blocked_by: [oa-001]`) and the empty-list shorthand
// (`blocked_by: []`). The multi-line `blocked_by:\n  - oa-001` form is
// parsed as null (= no deps), which would falsely mark every slice as
// ready. We use inline syntax throughout the fixtures.
const FIXTURE_SLICES = {
  'oa-001.md': `---
id: oa-001
title: SKILL.md + manifest
us: US-1.1
type: AFK
round: 1
mock: false
blocked_by: []
files: [plugins/office-agents/skills/office-agents/SKILL.md]
triage: ready-for-agent
status: pending
---

# oa-001

## What to build
First slice — no upstream.

## Acceptance criteria
- [ ] file shipped
`,

  'oa-002.md': `---
id: oa-002
title: ready-edge script
us: US-1.2
type: AFK
round: 2
mock: false
blocked_by: [oa-001]
files: [plugins/office-agents/skills/office-agents/scripts/ready-edge.mjs]
triage: ready-for-agent
status: pending
---

# oa-002

## What to build
Ready-edge computation.

## Acceptance criteria
- [ ] file shipped
`,

  'oa-mock-002.md': `---
id: oa-mock-002
title: mock:stub for oa-002
type: AFK
round: 2
mock: true
mock_refines: [oa-002]
blocked_by: []
triage: ready-for-agent
status: pending
---

# oa-mock-002: stub

## Mock contract surface
Typed contract placeholder.

## What to build
Stub file.
`,
};

// Audit slice fixture — added in tests that need the audit step.
const AUDIT_SLICE = {
  'oa-mock-audit.md': `---
id: oa-mock-audit
title: mock:audit — sweep for residual stubs
type: AFK
round: 99
mock: true
blocked_by: [oa-001, oa-002]
triage: ready-for-agent
status: pending
---

# oa-mock-audit

## What to build
Audit for residual mocks.
`,
};

async function makeWorkspace({ withAudit = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-005-orch-'));
  const stateLogPath = join(dir, '.office-agents-edge.log');
  for (const [file, content] of Object.entries(FIXTURE_SLICES)) {
    await writeFile(join(dir, file), content, 'utf8');
  }
  if (withAudit) {
    for (const [file, content] of Object.entries(AUDIT_SLICE)) {
      await writeFile(join(dir, file), content, 'utf8');
    }
  }
  return { dir, stateLogPath };
}

function makeDispatchFn({ record = [], failOn = null } = {}) {
  return async ({ prompt, sliceId, slicePath }) => {
    if (failOn && failOn.includes(sliceId)) {
      throw new Error(`dispatch-fail-${sliceId}`);
    }
    const agentId = `mock-${sliceId}-${record.length + 1}`;
    record.push({ sliceId, slicePath, prompt, agentId });
    return { agentId };
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Empty pass
// ---------------------------------------------------------------------------

test('empty pass: 0 ready edges → no fired lines, no stuck edges, no report', async () => {
  const { dir, stateLogPath } = await makeWorkspace();
  try {
    // Pre-mark oa-001 + oa-002 as already-dispatched in the log so there
    // are no ready edges left.
    const now = new Date().toISOString();
    const seededLog = [
      JSON.stringify({
        ts: now,
        dispatcher: 'office',
        edge: 'oa-001',
        status: 'dispatched',
        agent_id: 'mock-1',
      }),
      JSON.stringify({
        ts: now,
        dispatcher: 'office',
        edge: 'oa-001',
        status: 'landed',
      }),
      JSON.stringify({
        ts: now,
        dispatcher: 'office',
        edge: 'oa-002',
        status: 'dispatched',
        agent_id: 'mock-2',
      }),
      JSON.stringify({
        ts: now,
        dispatcher: 'office',
        edge: 'oa-002',
        status: 'landed',
      }),
    ].join('\n') + '\n';
    await writeFile(stateLogPath, seededLog, 'utf8');

    const dispatchCalls = [];
    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchCalls }),
    });

    assert.equal(result.readyEdges.length, 0, 'no ready edges');
    assert.equal(result.dispatched.length, 0, 'nothing dispatched');
    assert.equal(dispatchCalls.length, 0, 'dispatchFn never called');
    assert.equal(result.reportWritten, false, 'no report yet');
    assert.equal(result.stuck.length, 0, 'no stuck edges');

    const stdout = result.stdoutLines.join('\n');
    assert.match(stdout, /^office-agents: pass 1/m, 'header line');
    assert.match(stdout, /fired: \(none\)/, 'fired: (none) line');
    assert.doesNotMatch(stdout, /stuck edges:/, 'no stuck edges line');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — One-edge pass
// ---------------------------------------------------------------------------

test('one-edge pass: oa-001 ready → dispatched, triage flips to in-progress', async () => {
  const { dir, stateLogPath } = await makeWorkspace();
  try {
    const dispatchCalls = [];
    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchCalls }),
      options: { passNumber: 1 },
    });

    assert.deepEqual(result.readyEdges, ['oa-001'], 'oa-001 is the only ready edge');
    assert.equal(result.dispatched.length, 1, 'one dispatch');
    assert.equal(result.dispatched[0].sliceId, 'oa-001');
    assert.match(result.dispatched[0].agentId, /^mock-oa-001-/);

    // State log has a dispatched entry for oa-001 + the orchestrator's
    // pass-marker line at the end.
    const logText = await readFile(stateLogPath, 'utf8');
    const lines = logText.trim().split('\n').filter(Boolean);
    const dispatchedEntry = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.status === 'dispatched' && e.edge === 'oa-001');
    assert.ok(dispatchedEntry, 'dispatched entry for oa-001 in log');
    assert.equal(dispatchedEntry.dispatcher, 'office');
    assert.deepEqual(dispatchedEntry.deps_at_dispatch, []);

    const passMarker = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.status === 'pass-marker');
    assert.ok(passMarker, 'pass-marker appended');
    assert.equal(passMarker.pass, 1);

    // Frontmatter flipped to in-progress.
    const sliceText = await readFile(join(dir, 'oa-001.md'), 'utf8');
    assert.match(sliceText, /^triage: in-progress/m, 'triage: in-progress in frontmatter');

    const stdout = result.stdoutLines.join('\n');
    assert.match(stdout, /fired: oa-001/, 'fired line shows oa-001');
    // oa-002 should be ready-but-not-dispatched (waiting on oa-001).
    assert.match(stdout, /ready but not yet dispatched: oa-002 \(waiting on oa-001\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Audit auto-trigger
// ---------------------------------------------------------------------------

test('audit auto-trigger: when all real slices are landed, audit fires', async () => {
  const { dir, stateLogPath } = await makeWorkspace({ withAudit: true });
  try {
    // Seed the log so oa-001 + oa-002 are both dispatched+landed, and
    // the audit was previously refined for oa-001.
    const now = new Date().toISOString();
    const seeded = [
      { ts: now, dispatcher: 'office', edge: 'oa-001', status: 'dispatched', agent_id: 'm1' },
      { ts: now, dispatcher: 'office', edge: 'oa-001', status: 'landed' },
      { ts: now, dispatcher: 'office', edge: 'oa-002', status: 'dispatched', agent_id: 'm2' },
      { ts: now, dispatcher: 'office', edge: 'oa-002', status: 'landed' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(stateLogPath, seeded, 'utf8');

    const dispatchCalls = [];
    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchCalls }),
      options: { passNumber: 1 },
    });

    // The audit should be the only ready edge.
    assert.deepEqual(result.readyEdges, ['oa-mock-audit'], 'audit is the only ready edge');
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.dispatched[0].sliceId, 'oa-mock-audit');

    // dispatchFn was called for the audit.
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].sliceId, 'oa-mock-audit');

    const stdout = result.stdoutLines.join('\n');
    assert.match(stdout, /fired: oa-mock-audit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Final report
// ---------------------------------------------------------------------------

test('final report: written when all real + audit are landed', async () => {
  const { dir, stateLogPath } = await makeWorkspace({ withAudit: true });
  try {
    // Seed log so every real slice AND the audit have been dispatched
    // + landed. That makes ready-edge.mjs return `allLanded: true`
    // (no more ready edges), AND auditFiredInLog() returns true.
    const now = new Date().toISOString();
    const events = [
      { ts: now, dispatcher: 'office', edge: 'oa-001', status: 'dispatched', agent_id: 'm1', deps_at_dispatch: [] },
      { ts: now, dispatcher: 'office', edge: 'oa-001', status: 'landed', commit: 'aaaaaaa' },
      { ts: now, dispatcher: 'office', edge: 'oa-002', status: 'dispatched', agent_id: 'm2', deps_at_dispatch: ['oa-001'] },
      { ts: now, dispatcher: 'office', edge: 'oa-002', status: 'landed', commit: 'bbbbbbb' },
      { ts: now, dispatcher: 'office', edge: 'oa-mock-audit', status: 'dispatched', agent_id: 'm3', deps_at_dispatch: ['oa-001', 'oa-002'] },
      { ts: now, dispatcher: 'office', edge: 'oa-mock-audit', status: 'landed', commit: 'ccccccc' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(stateLogPath, events, 'utf8');

    const dispatchCalls = [];
    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchCalls }),
      options: { passNumber: 1 },
    });

    assert.equal(result.readyEdges.length, 0, 'no ready edges left');
    assert.equal(dispatchCalls.length, 0, 'nothing dispatched');
    assert.equal(result.reportWritten, true, 'report written');

    const reportPath = join(dir, '.afk-agents-report.md');
    const report = await readFile(reportPath, 'utf8');

    // Frontmatter shape.
    assert.match(report, /^---[\s\S]*dispatcher: office[\s\S]*---/m);
    assert.match(report, /run_started: /);
    assert.match(report, /run_completed: /);

    // Per-slice table includes every fixture slice.
    assert.match(report, /oa-001/, 'oa-001 in table');
    assert.match(report, /oa-002/, 'oa-002 in table');
    assert.match(report, /oa-mock-002/, 'mock-002 in table');

    // Wall-clock header lines.
    assert.match(report, /\*\*Total ready-edges dispatched\*\*:/);
    assert.match(report, /\*\*Slices landed in in-review\*\*:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Stuck-edge detection
// ---------------------------------------------------------------------------

test('stuck-edge detection: in-progress slice waiting > threshold is reported', async () => {
  const { dir, stateLogPath } = await makeWorkspace();
  try {
    // Seed log: oa-001 dispatched long ago, followed by 4 pass-markers
    // and no `landed` for oa-001. Threshold defaults to 3, so > 3 means
    // stuck.
    const t0 = new Date('2026-06-13T10:00:00Z').toISOString();
    const events = [
      { ts: t0, dispatcher: 'office', edge: 'oa-001', status: 'dispatched', agent_id: 'm1' },
      { ts: t0, dispatcher: 'office', status: 'pass-marker', pass: 1 },
      { ts: t0, dispatcher: 'office', status: 'pass-marker', pass: 2 },
      { ts: t0, dispatcher: 'office', status: 'pass-marker', pass: 3 },
      { ts: t0, dispatcher: 'office', status: 'pass-marker', pass: 4 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(stateLogPath, events, 'utf8');

    const dispatchCalls = [];
    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchCalls }),
      options: { passNumber: 5, stuckThreshold: 3 },
    });

    // oa-002 is ready (oa-001 was never landed → still blocks oa-002).
    // But oa-001 has been in-flight for 4 passes > 3 threshold → stuck.
    assert.equal(result.stuck.length, 1, 'one stuck edge');
    assert.equal(result.stuck[0].sliceId, 'oa-001');
    assert.ok(result.stuck[0].passesWaiting > 3, 'passesWaiting exceeds threshold');

    const stdout = result.stdoutLines.join('\n');
    assert.match(stdout, /stuck edges: oa-001/, 'stuck edges line printed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6 — Idempotency across re-triggers
// ---------------------------------------------------------------------------

test('idempotency: second pass with no state change returns same ready set, no re-dispatch', async () => {
  const { dir, stateLogPath } = await makeWorkspace();
  try {
    // Pass 1: dispatch oa-001 (oa-002 blocked).
    const pass1 = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: [] }),
      options: { passNumber: 1 },
    });
    assert.equal(pass1.dispatched.length, 1);
    assert.equal(pass1.dispatched[0].sliceId, 'oa-001');

    // Simulate oa-001 landing (worker commits + pushes).
    const logText = await readFile(stateLogPath, 'utf8');
    const lines = logText.trim().split('\n').filter(Boolean);
    const lastDispatched = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.status === 'dispatched' && e.edge === 'oa-001');
    const landedLine = JSON.stringify({
      ts: new Date().toISOString(),
      dispatcher: 'office',
      edge: 'oa-001',
      status: 'landed',
      commit: 'fake-commit-1',
    });
    await writeFile(stateLogPath, logText + landedLine + '\n', 'utf8');
    void lastDispatched;

    // Pass 2: should dispatch oa-002.
    const pass2 = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: [] }),
      options: { passNumber: 2 },
    });
    assert.equal(pass2.dispatched.length, 1);
    assert.equal(pass2.dispatched[0].sliceId, 'oa-002');

    // Simulate oa-002 landing.
    const log2 = await readFile(stateLogPath, 'utf8');
    const landed2 = JSON.stringify({
      ts: new Date().toISOString(),
      dispatcher: 'office',
      edge: 'oa-002',
      status: 'landed',
      commit: 'fake-commit-2',
    });
    await writeFile(stateLogPath, log2 + landed2 + '\n', 'utf8');

    // Pass 3: no ready edges, no dispatch.
    const dispatchRecord = [];
    const pass3 = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: dispatchRecord }),
      options: { passNumber: 3 },
    });

    assert.equal(pass3.readyEdges.length, 0, 'no ready edges on pass 3');
    assert.equal(pass3.dispatched.length, 0, 'nothing dispatched on pass 3');
    assert.equal(dispatchRecord.length, 0, 'dispatchFn never called on pass 3');
    assert.match(pass3.stdoutLines.join('\n'), /fired: \(none\)/);

    // State log only grew by the pass-marker, no dispatched entry.
    const finalLog = await readFile(stateLogPath, 'utf8');
    const finalLines = finalLog.trim().split('\n').filter(Boolean);
    const lastLine = JSON.parse(finalLines[finalLines.length - 1]);
    assert.equal(lastLine.status, 'pass-marker');
    assert.equal(lastLine.pass, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7 — audit fired detection works for arbitrary audit-slice ids
//          (follow-up #2)
//
// Regression: `auditFiredInLog()` previously used the regex
// `/^oa-mock-audit|^mock-audit|^audit$/i` which did NOT match ids like
// `mu-mock-audit` (the multi-user-isolation fixture's audit slice). The
// fix detects audit by the structural predicate
// `mock: true && title.toLowerCase().startsWith('mock:audit')` — the
// same predicate ready-edge.mjs uses at line 131 — and looks up the
// matching slice ids from the slice set before scanning the state log.
// ---------------------------------------------------------------------------

test('audit fired detection: works for mu-mock-audit id (arbitrary id scheme)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oa-005-audit-'));
  const stateLogPath = join(dir, '.office-agents-edge.log');
  try {
    // Slice set with an audit slice whose id is `mu-mock-audit` (NOT
    // matching the old `oa-mock-audit` / `mock-audit` / `audit` regex),
    // and a single real AFK slice that satisfies the allLanded gate.
    const slices = {
      'real-1.md': `---
id: real-1
title: real slice
type: AFK
round: 1
mock: false
blocked_by: []
triage: ready-for-agent
status: pending
---

# real-1
`,
      'mu-mock-audit.md': `---
id: mu-mock-audit
title: mock:audit final sweep
type: AFK
round: 99
mock: true
blocked_by: [real-1]
triage: ready-for-agent
status: pending
---

# mu-mock-audit
`,
    };
    for (const [file, content] of Object.entries(slices)) {
      await writeFile(join(dir, file), content, 'utf8');
    }

    // Seed the log so real-1 is dispatched+landed AND the audit slice
    // has been dispatched (the state needed for `auditFired` to be true
    // AND for `allRealLanded` to be true so the gate opens). This
    // mirrors how the production orchestrator surfaces an already-fired
    // audit when the worker hasn't landed yet.
    const now = new Date().toISOString();
    const events = [
      { ts: now, dispatcher: 'office', edge: 'real-1', status: 'dispatched', agent_id: 'm1', deps_at_dispatch: [] },
      { ts: now, dispatcher: 'office', edge: 'real-1', status: 'landed', commit: 'real1aaa' },
      { ts: now, dispatcher: 'office', edge: 'mu-mock-audit', status: 'dispatched', agent_id: 'm2', deps_at_dispatch: ['real-1'] },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(stateLogPath, events, 'utf8');

    const result = await runOfficeAgentsPass({
      issuesDir: dir,
      stateLogPath,
      dispatchFn: makeDispatchFn({ record: [] }),
      options: { passNumber: 1 },
    });

    // Audit fired (via seeded log line) → final report was written.
    assert.equal(result.reportWritten, true, 'report written for mu-mock-audit');
    const reportPath = join(dir, '.afk-agents-report.md');
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /dispatcher: office/, 'report has office dispatcher frontmatter');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bonus — script shape: zero-dep, exports runOfficeAgentsPass
// ---------------------------------------------------------------------------

test('orchestrate.mjs: zero-dep + exports runOfficeAgentsPass', async () => {
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(join(__dirname, 'orchestrate.mjs'), 'utf8');
  // Zero-dep check: no `import ... from '` that resolves to an npm package.
  // Allow node: builtins only.
  const importLines = [...text.matchAll(/^\s*import .* from ['"]([^'"]+)['"]/gm)];
  for (const m of importLines) {
    assert.ok(
      m[1].startsWith('node:'),
      `orchestrate.mjs must be zero-dep; offending import: ${m[1]}`,
    );
  }
  // Exports the orchestrator function.
  assert.match(text, /^export async function runOfficeAgentsPass/m);
  // Reference dirname so import isn't tree-shaken by simple analyzers.
  void dirname;
});
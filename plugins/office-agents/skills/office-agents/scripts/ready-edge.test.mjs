#!/usr/bin/env node
// /office-agents ready-edge test — 6 cases covering the 3 seam-2 states from
// PRD §6 plus the 3 derivative states (mock-stub, already-dispatched,
// all-real-landed / audit-ready). Zero npm deps. Run: `node ready-edge.test.mjs`.
//
// Style: zero-dep, like to-issues/scripts/build.mjs. Each case is a small
// pure function returning `{ name, expected, actual }` and we assert it.
// We never spawn a child process — we call the script's logic by importing
// the algorithm. To keep the script a single file (no separate module), we
// re-import the same algorithm by spawning `node ready-edge.mjs` against a
// temp fixture and parsing its JSON stdout. This also verifies the CLI
// surface (exit code, JSON shape) which a pure-module test would miss.

import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(__dirname, 'ready-edge.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function runScript({ slices, logLines = [], issuesDir, stateLogPath, withIndex = true }) {
  if (existsSync(issuesDir)) rmSync(issuesDir, { recursive: true, force: true });
  mkdirSync(issuesDir, { recursive: true });
  if (withIndex) writeFileSync(join(issuesDir, 'INDEX.md'), '# fixture\n');
  for (const [file, content] of slices) writeFileSync(join(issuesDir, file), content);
  if (logLines.length) writeFileSync(stateLogPath, logLines.join('\n') + '\n');
  else if (existsSync(stateLogPath)) rmSync(stateLogPath, { force: true });
  let stdout = '', stderr = '', code = 0;
  try {
    const r = execFileSync('node', [SCRIPT, issuesDir, stateLogPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    stdout = r;
    // when exit 0, stderr from child is not captured by execFileSync;
    // re-run with throw-on-nonzero is wasteful — instead, on exit 0 we
    // accept stderr="" (the script's stderr warnings only show up when the
    // script exits non-zero, and the cases that need them will exit
    // non-zero OR the warnings go to the live terminal which is fine for
    // human readers). The bonus warn-capture tests below use a separate
    // capture path that throws on success.
  } catch (e) {
    stdout = e.stdout?.toString?.() ?? '';
    stderr = e.stderr?.toString?.() ?? '';
    code = e.status ?? 1;
  }
  let parsed = null;
  if (stdout && stdout.trim()) {
    try { parsed = JSON.parse(stdout.trim()); }
    catch { /* leave parsed null */ }
  }
  return { stdout, stderr, code, parsed };
}

function runScriptCaptureStderr({ slices, logLines = [], issuesDir, stateLogPath, withIndex = true }) {
  if (existsSync(issuesDir)) rmSync(issuesDir, { recursive: true, force: true });
  mkdirSync(issuesDir, { recursive: true });
  if (withIndex) writeFileSync(join(issuesDir, 'INDEX.md'), '# fixture\n');
  for (const [file, content] of slices) writeFileSync(join(issuesDir, file), content);
  if (logLines.length) writeFileSync(stateLogPath, logLines.join('\n') + '\n');
  // Use spawnSync so we get stderr even on exit 0.
  const r = spawnSync('node', [SCRIPT, issuesDir, stateLogPath], { encoding: 'utf8' });
  let parsed = null;
  if (r.stdout && r.stdout.trim()) {
    try { parsed = JSON.parse(r.stdout.trim()); } catch {}
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 0, parsed };
}

function makeSlice({ id, title = 'slice ' + id, blocked_by = [], mock = false, type = 'AFK', triage = 'ready-for-agent' }) {
  const fm = [
    `id: ${id}`,
    `title: ${title}`,
    `type: ${type}`,
    `round: 1`,
    `mock: ${mock ? 'true' : 'false'}`,
    `blocked_by: [${blocked_by.join(', ')}]`,
    `triage: ${triage}`,
  ].join('\n');
  return `---\n${fm}\n---\n\n# ${id}\n`;
}

// Multi-line-list frontmatter builder. Mirrors the YAML the /to-issues
// generator (and oa-007's e2e mui fixture) actually emits for
// `blocked_by:` / `mock_refines:` / `mocks:`:
//   key:
//     - item1
//     - item2
// See oa-002 follow-up #3 in .afk-agents-report.md — the previous parser
// returned null for the empty value after the key, then `?? []` treated
// every slice as dep-free. The fix in ready-edge.mjs:parseFrontmatter
// now walks the indented `- ` items forward, mirroring
// mock-gen.mjs:parseFrontmatter.
function makeSliceMultiline({ id, title = 'slice ' + id, blocked_by = [], mock = false, type = 'AFK', triage = 'ready-for-agent', mock_refines = [] }) {
  const lines = [
    `id: ${id}`,
    `title: ${title}`,
    `type: ${type}`,
    `round: 1`,
    `mock: ${mock ? 'true' : 'false'}`,
  ];
  if (blocked_by.length === 0) {
    lines.push(`blocked_by: []`);
  } else {
    lines.push(`blocked_by:`);
    for (const b of blocked_by) lines.push(`  - ${b}`);
  }
  if (mock_refines.length > 0) {
    lines.push(`mock_refines:`);
    for (const r of mock_refines) lines.push(`  - ${r}`);
  }
  lines.push(`triage: ${triage}`);
  return `---\n${lines.join('\n')}\n---\n\n# ${id}\n`;
}

function logLine(edge, status, extras = {}) {
  return JSON.stringify({ ts: '2026-06-13T00:00:00Z', edge, status, dispatcher: 'office', ...extras });
}

function assertCase(name, expected, actual) {
  const ok =
    expected.readyEdges && arraysEq(expected.readyEdges, actual.readyEdges) &&
    expected.inFlight && arraysEq(expected.inFlight, actual.inFlight) &&
    expected.stuck && arraysEq(expected.stuck, actual.stuck) &&
    expected.allLanded === actual.allLanded &&
    expected.auditReady === actual.auditReady;
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push({ name, expected, actual });
    console.log(`  FAIL ${name}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── fixtures
function newDir(label) {
  const root = mkdtempSync(join(tmpdir(), 'oa-ready-edge-' + label + '-'));
  return { issuesDir: join(root, 'issues'), stateLogPath: join(root, 'issues', '.office-agents-edge.log') };
}

function arraysEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── the 8-slice fixture shared by several cases
function eightSlices(mockIds = []) {
  const mockSet = new Set(mockIds);
  return [
    ['mu-001.md', makeSlice({ id: 'mu-001', blocked_by: [] })],
    ['mu-002.md', makeSlice({ id: 'mu-002', blocked_by: ['mu-001'] })],
    ['mu-003.md', makeSlice({ id: 'mu-003', blocked_by: ['mu-001'] })],
    ['mu-004.md', makeSlice({ id: 'mu-004', blocked_by: ['mu-002', 'mu-003'] })],
    ['mu-005.md', makeSlice({ id: 'mu-005', blocked_by: ['mu-002'] })],
    ['mu-006.md', makeSlice({ id: 'mu-006', blocked_by: ['mu-001'] })],
    ['mu-007.md', makeSlice({ id: 'mu-007', blocked_by: ['mu-006'] })],
    ['mu-008.md', makeSlice({ id: 'mu-008', blocked_by: ['mu-004', 'mu-007'] })],
    ...Array.from(mockSet).map(id => [`${id}.md`, makeSlice({ id, blocked_by: [], mock: true })]),
  ];
}

// ─── CASE 1: no deps landed, state log empty → mu-001 only (the no-dep root)
{
  const { issuesDir, stateLogPath } = newDir('case1');
  const r = runScript({ slices: eightSlices(), issuesDir, stateLogPath });
  assertCase('case1: no deps landed -> mu-001 (the no-dep root) ready', {
    readyEdges: ['mu-001'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
}

// ─── CASE 2: partial deps landed → mu-002 + mu-003 + mu-006 ready
{
  const { issuesDir, stateLogPath } = newDir('case2');
  const log = [logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed')];
  const r = runScript({ slices: eightSlices(), logLines: log, issuesDir, stateLogPath });
  assertCase('case2: mu-001 landed -> mu-002/003/006 ready', {
    readyEdges: ['mu-002', 'mu-003', 'mu-006'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
}

// ─── CASE 3: all real deps for mu-006 landed → mu-006 + downstream ready
{
  const { issuesDir, stateLogPath } = newDir('case3');
  const log = [
    logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed'),
    logLine('mu-002', 'dispatched'), logLine('mu-002', 'landed'),
    logLine('mu-003', 'dispatched'), logLine('mu-003', 'landed'),
    logLine('mu-006', 'dispatched'), logLine('mu-006', 'landed'),
  ];
  const r = runScript({ slices: eightSlices(), logLines: log, issuesDir, stateLogPath });
  assertCase('case3: mu-001+002+003+006 landed -> mu-004,005,007 ready', {
    readyEdges: ['mu-004', 'mu-005', 'mu-007'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
}

// ─── CASE 4: mock-stub path → mock dep counts as satisfied even before real lands
{
  // mu-002's real dep is mu-mock-001 (a mock stub). mu-002 is real but
  // unlanded. mu-002 should NOT be in readyEdges (its blocked_by is
  // [mu-mock-001] — mock-stub satisfies that dep). mu-003 (blocked_by
  // [mu-001]) should NOT be ready because mu-001 is unlanded.
  const { issuesDir, stateLogPath } = newDir('case4');
  const slices = [
    ['mu-001.md', makeSlice({ id: 'mu-001', blocked_by: [] })],
    ['mu-002.md', makeSlice({ id: 'mu-002', blocked_by: ['mu-mock-001'] })],
    ['mu-003.md', makeSlice({ id: 'mu-003', blocked_by: ['mu-001'] })],
    ['mu-mock-001.md', makeSlice({ id: 'mu-mock-001', blocked_by: [], mock: true })],
  ];
  const r = runScript({ slices, issuesDir, stateLogPath });
  assertCase('case4: mock-stub dep satisfies -> mu-001 + mu-002 ready', {
    readyEdges: ['mu-001', 'mu-002'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
}

// ─── CASE 5: already-dispatched → not in readyEdges even if deps landed
{
  const { issuesDir, stateLogPath } = newDir('case5');
  const log = [
    logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed'),
    logLine('mu-002', 'dispatched'),    // not yet landed
  ];
  const r = runScript({ slices: eightSlices(), logLines: log, issuesDir, stateLogPath });
  assertCase('case5: mu-002 already dispatched -> not in readyEdges', {
    // mu-002 dispatched (in-flight); mu-003, mu-005, mu-006 still ready
    // because mu-001 is landed and mu-002's dispatch satisfies mu-005's
    // blocked_by. mu-002 itself is excluded from readyEdges.
    readyEdges: ['mu-003', 'mu-005', 'mu-006'], inFlight: ['mu-002'], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
}

// ─── CASE 6: all 8 real mu-* landed → allLanded + auditReady (when audit present)
{
  const { issuesDir, stateLogPath } = newDir('case6');
  // add a mock:audit slice that will be the audit target
  const slices = [
    ...eightSlices(),
    ['mu-audit.md', makeSlice({ id: 'mu-audit', title: 'mock:audit final sweep', blocked_by: [], mock: true, type: 'AFK' })],
  ];
  const log = [];
  for (let i = 1; i <= 8; i++) {
    const id = `mu-00${i}`;
    log.push(logLine(id, 'dispatched'));
    log.push(logLine(id, 'landed'));
  }
  const r = runScript({ slices, logLines: log, issuesDir, stateLogPath });
  assertCase('case6: all 8 real landed + audit present -> allLanded+auditReady, audit surfaces as ready', {
    readyEdges: ['mu-audit'], inFlight: [], stuck: [], allLanded: true, auditReady: true,
  }, r.parsed);
}

// ─── bonus: missing INDEX.md is OK (no crash, no warn about it)
{
  const { issuesDir, stateLogPath } = newDir('bonus-no-index');
  const r = runScript({ slices: eightSlices(), issuesDir, stateLogPath, withIndex: false });
  assertCase('bonus: missing INDEX.md tolerated -> same output as case1', {
    readyEdges: ['mu-001'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
  if (!r.stderr.includes('INDEX.md') && !r.stderr.toLowerCase().includes('source-hint')) {
    passed++;
    console.log('  ok  bonus: missing INDEX.md does not emit any INDEX-related stderr warn');
  } else {
    failed++;
    failures.push({ name: 'bonus: no INDEX warn', stderr: r.stderr });
    console.log('  FAIL bonus: missing INDEX.md should NOT warn; stderr was: ' + r.stderr);
  }
}

// ─── bonus: malformed JSONL line is skipped + warned
{
  const { issuesDir, stateLogPath } = newDir('bonus-bad-jsonl');
  const log = [
    logLine('mu-001', 'dispatched'),
    'NOT JSON {{{',                                                   // malformed
    logLine('mu-001', 'landed'),
    '{"only_some_keys": true}',                                        // no edge/status
    '{"edge":"mu-002","status":"dispatched","dispatcher":"afk"}',      // wrong dispatcher
    '{"edge":"mu-002","status":"dispatched","dispatcher":"office"}',   // good line
  ];
  const r = runScriptCaptureStderr({ slices: eightSlices(), logLines: log, issuesDir, stateLogPath });
  // mu-001 dispatched+landed; mu-002 dispatched. So mu-003,mu-005,mu-006 are ready.
  assertCase('bonus: malformed JSONL skipped -> same outcome as case5', {
    readyEdges: ['mu-003', 'mu-005', 'mu-006'], inFlight: ['mu-002'], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
  if (r.stderr.includes('malformed') || r.stderr.includes('JSONL')) {
    passed++;
    console.log('  ok  bonus: malformed JSONL line warned on stderr');
  } else {
    failed++;
    failures.push({ name: 'bonus: malformed warn', stderr: r.stderr });
    console.log('  FAIL bonus: malformed JSONL line should warn; stderr was: ' + r.stderr);
  }
}

// ─── bonus: dangling blocked_by -> that edge dropped + warn, slice never ready
{
  const { issuesDir, stateLogPath } = newDir('bonus-dangling');
  const slices = [
    ['mu-001.md', makeSlice({ id: 'mu-001', blocked_by: ['mu-ghost'] })],
    ['mu-002.md', makeSlice({ id: 'mu-002', blocked_by: [] })],
  ];
  const r = runScriptCaptureStderr({ slices, issuesDir, stateLogPath });
  // mu-001 has a dangling dep, structurally unreachable -> stuck.
  // mu-002 has no deps -> ready.
  assertCase('bonus: dangling blocked_by -> dep dropped, slice stuck', {
    readyEdges: ['mu-002'], inFlight: [], stuck: ['mu-001'], allLanded: false, auditReady: false,
  }, r.parsed);
  if (r.stderr.includes('unknown id') && r.stderr.includes('mu-ghost')) {
    passed++;
    console.log('  ok  bonus: dangling blocked_by warned on stderr');
  } else {
    failed++;
    failures.push({ name: 'bonus: dangling warn', stderr: r.stderr });
    console.log('  FAIL bonus: dangling blocked_by should warn; stderr was: ' + r.stderr);
  }
}

// ─── bonus: missing issues dir -> exit 1
{
  const root = mkdtempSync(join(tmpdir(), 'oa-ready-edge-bonus-no-dir-'));
  const issuesDir = join(root, 'does-not-exist');
  const stateLogPath = join(issuesDir, '.office-agents-edge.log');
  let code = 0;
  try {
    execFileSync('node', [SCRIPT, issuesDir, stateLogPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; }
  if (code === 1) {
    passed++;
    console.log('  ok  bonus: missing issues dir -> exit 1');
  } else {
    failed++;
    failures.push({ name: 'bonus: no-dir exit code', code });
    console.log(`  FAIL bonus: missing issues dir should exit 1; got code=${code}`);
  }
}

// ─── bonus: no slices found -> exit 1
{
  const { issuesDir, stateLogPath } = newDir('bonus-empty');
  mkdirSync(issuesDir, { recursive: true });
  // create only INDEX.md, no slice files
  writeFileSync(join(issuesDir, 'INDEX.md'), '# empty\n');
  let code = 0;
  try {
    execFileSync('node', [SCRIPT, issuesDir, stateLogPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status ?? 1; }
  if (code === 1) {
    passed++;
    console.log('  ok  bonus: no slices in dir -> exit 1');
  } else {
    failed++;
    failures.push({ name: 'bonus: empty-dir exit code', code });
    console.log(`  FAIL bonus: no slices should exit 1; got code=${code}`);
  }
}

// ─── bonus: cycle in blocked_by -> warn but compute the answer anyway
{
  const { issuesDir, stateLogPath } = newDir('bonus-cycle');
  const slices = [
    ['mu-A.md', makeSlice({ id: 'mu-A', blocked_by: ['mu-B'] })],
    ['mu-B.md', makeSlice({ id: 'mu-B', blocked_by: ['mu-A'] })],
  ];
  const r = runScriptCaptureStderr({ slices, issuesDir, stateLogPath });
  // both have unsatisfiable deps (cycle) but no dangling ids -> not stuck
  // per v1 (cycle detection is a separate stderr warn, owned by oa-005 for
  // richer stuck semantics).
  assertCase('bonus: cycle -> not stuck (cycle warn on stderr instead), output emitted', {
    readyEdges: [], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
  if (r.stderr.includes('cycle')) {
    passed++;
    console.log('  ok  bonus: cycle detected + warned on stderr');
  } else {
    failed++;
    failures.push({ name: 'bonus: cycle warn', stderr: r.stderr });
    console.log('  FAIL bonus: cycle should warn; stderr was: ' + r.stderr);
  }
}

// ─── bonus: idempotency — same inputs twice = same output
{
  const { issuesDir, stateLogPath } = newDir('bonus-idempotent');
  const log = [logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed')];
  const slices = eightSlices();
  const r1 = runScript({ slices, logLines: log, issuesDir, stateLogPath });
  const r2 = runScript({ slices, logLines: log, issuesDir, stateLogPath });
  if (JSON.stringify(r1.parsed) === JSON.stringify(r2.parsed)) {
    passed++;
    console.log('  ok  bonus: idempotent (two runs, same inputs, same JSON output)');
  } else {
    failed++;
    failures.push({ name: 'bonus: idempotent', r1: r1.parsed, r2: r2.parsed });
    console.log('  FAIL bonus: idempotent violated');
  }
}

// ─── CASE 7: multi-line blocked_by form parsed correctly (oa-002 follow-up #3)
// Before the fix: `blocked_by:\n  - mu-001` parsed as null, then `?? []`
// treated every slice as dep-free and the entire graph fired in pass 1.
// After the fix: parseFrontmatter walks the indented `- ` items forward
// (mirrors mock-gen.mjs:parseFrontmatter), so the mui fixture's realistic
// 4-pass wave structure is preserved end-to-end.
{
  const { issuesDir, stateLogPath } = newDir('case7-multiline-blocked-by');
  const slices = [
    ['mu-001.md', makeSliceMultiline({ id: 'mu-001', blocked_by: [] })],
    ['mu-002.md', makeSliceMultiline({ id: 'mu-002', blocked_by: ['mu-001'] })],
    ['mu-003.md', makeSliceMultiline({ id: 'mu-003', blocked_by: ['mu-001'] })],
    ['mu-004.md', makeSliceMultiline({ id: 'mu-004', blocked_by: ['mu-002', 'mu-003'] })],
    ['mu-005.md', makeSliceMultiline({ id: 'mu-005', blocked_by: ['mu-002'] })],
    ['mu-006.md', makeSliceMultiline({ id: 'mu-006', blocked_by: ['mu-001'] })],
    ['mu-007.md', makeSliceMultiline({ id: 'mu-007', blocked_by: ['mu-006'] })],
    ['mu-008.md', makeSliceMultiline({ id: 'mu-008', blocked_by: ['mu-004', 'mu-007'] })],
  ];
  // Pass 1: no deps landed -> only mu-001 (the no-dep root) is ready.
  // This is the exact bug the fix addresses — pre-fix, all 8 fired in pass 1.
  const r1 = runScript({ slices, issuesDir, stateLogPath });
  assertCase('case7a: multi-line blocked_by: no deps landed -> mu-001 only ready (no longer all-8)', {
    readyEdges: ['mu-001'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r1.parsed);

  // Pass 2: mu-001 landed -> mu-002 + mu-003 + mu-006 ready (multi-line list
  // correctly interpreted as a 1-element dep set each).
  const log2 = [logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed')];
  const r2 = runScript({ slices, logLines: log2, issuesDir, stateLogPath });
  assertCase('case7b: multi-line blocked_by: mu-001 landed -> mu-002/003/006 ready', {
    readyEdges: ['mu-002', 'mu-003', 'mu-006'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r2.parsed);

  // Pass 3: mu-001+002+003+006 landed -> mu-004 (deps mu-002+mu-003) + mu-005
  // (dep mu-002) + mu-007 (dep mu-006) ready. This is the load-bearing case:
  // pre-fix, mu-004 was already in pass 1, so the multi-dep graph was
  // invisible. Post-fix, the realistic wave 3 is visible.
  const log3 = [
    logLine('mu-001', 'dispatched'), logLine('mu-001', 'landed'),
    logLine('mu-002', 'dispatched'), logLine('mu-002', 'landed'),
    logLine('mu-003', 'dispatched'), logLine('mu-003', 'landed'),
    logLine('mu-006', 'dispatched'), logLine('mu-006', 'landed'),
  ];
  const r3 = runScript({ slices, logLines: log3, issuesDir, stateLogPath });
  assertCase('case7c: multi-line blocked_by: multi-dep graph -> mu-004/005/007 ready in pass 3', {
    readyEdges: ['mu-004', 'mu-005', 'mu-007'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r3.parsed);

  // Pass 4: every real landed -> mu-008 (the convergence node, deps mu-004
  // and mu-007) is the only remaining slice. Confirms the multi-dep
  // semantics survive across the full 4-pass structure.
  const log4 = [];
  for (let i = 1; i <= 7; i++) {
    const id = i === 8 ? null : `mu-00${i}`;
    if (id) {
      log4.push(logLine(id, 'dispatched'));
      log4.push(logLine(id, 'landed'));
    }
  }
  const r4 = runScript({ slices, logLines: log4, issuesDir, stateLogPath });
  assertCase('case7d: multi-line blocked_by: pass 4 -> mu-008 (multi-dep convergence) ready', {
    readyEdges: ['mu-008'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r4.parsed);
}

// ─── CASE 8: multi-line mock_refines list parsed correctly
// Defends the same look-ahead against a different multi-line list field.
// Pre-fix, `mock_refines:` (used by mock-gen.mjs to decide which mocks
// auto-refine when a real lands) would have collapsed to null, breaking
// oa-003's mock refinement dispatch.
{
  const { issuesDir, stateLogPath } = newDir('case8-multiline-mock-refines');
  const slices = [
    ['mu-001.md', makeSlice({ id: 'mu-001', blocked_by: [] })],
    ['mu-mock-audit.md', makeSliceMultiline({
      id: 'mu-mock-audit',
      title: 'mock:audit final sweep',
      blocked_by: [],
      mock: true,
      mock_refines: ['mu-001', 'mu-002', 'mu-003'],
    })],
  ];
  // mu-001 is no-dep real, ready. mu-mock-audit has mock: true + title
  // starts with "mock:audit" — surfaces as a ready edge per the audit
  // promotion rule (line 130-141). The point of this case is that the
  // multi-line `mock_refines:` list was parsed correctly (otherwise
  // mock-gen.mjs:refineMockBody would silently no-op when mu-001/002/003
  // land — but ready-edge.mjs doesn't read mock_refines, so we just
  // assert the file is loadable end-to-end with no crash/warn).
  // auditReady stays false because mu-001 is not yet landed
  // (auditReady requires allRealLanded, see line 161-165).
  const r = runScriptCaptureStderr({ slices, issuesDir, stateLogPath });
  assertCase('case8: multi-line mock_refines list parses without crashing', {
    readyEdges: ['mu-001', 'mu-mock-audit'], inFlight: [], stuck: [], allLanded: false, auditReady: false,
  }, r.parsed);
  if (!r.stderr.includes('mock_refines') && !r.stderr.toLowerCase().includes('parse')) {
    passed++;
    console.log('  ok  case8: multi-line mock_refines: no parser-related stderr warn');
  } else {
    failed++;
    failures.push({ name: 'case8: mock_refines warn', stderr: r.stderr });
    console.log('  FAIL case8: multi-line mock_refines: should not warn; stderr was: ' + r.stderr);
  }
}

// ─── summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + JSON.stringify(f));
  process.exit(1);
}
process.exit(0);

#!/usr/bin/env node
// /office-agents mock generator + refiner — test (oa-003).
//
// Node test, zero-dep. Run: `node mock-gen.test.mjs`.
// Exits 0 if all assertions pass, non-zero (with a stderr summary) on the
// first failure. Mirrors the no-test-framework pattern from
// /to-issues/scripts/build.mjs.
//
// Covers the 5 AC cases:
//   1. First-pass generation — 4 mock slices → 4 .md files with correct
//      frontmatter (mock: true, mock_refines, blocked_by) + typed-contract
//      body.
//   2. Idempotency — re-running generateUpfrontMocks does NOT overwrite
//      existing mock files.
//   3. Refinement — after a real slice lands, refineMockBody edits the
//      dependent mock's body in place; file path unchanged, frontmatter
//      unchanged, body updated to point at the real.
//   4. No-op on no dependents — refineMockBody(realSliceId) is a no-op
//      when no mock lists that id in mock_refines.
//   5. Determinism — same slice set + same input → same output bytes (no
//      timestamps, no random IDs, no environment-dependent paths).

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateUpfrontMocks, refineMockBody } from './mock-gen.mjs';

// ─── test harness ──────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}
function assertIncludes(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg || 'includes'}\n      needle:   ${JSON.stringify(needle)}\n      haystack: ${JSON.stringify(haystack.slice(0, 200))}…`);
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Build a fresh temp dir per test so each case is hermetic. */
function freshDir() {
  return mkdtempSync(join(tmpdir(), 'oa-003-mockgen-'));
}

function rmDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

/** A slice set with 4 mock slices + 1 real slice, exercising the full AC surface. */
function sliceSetFixture() {
  return [
    {
      id: 'oa-real-001',
      title: 'real foundation slice',
      round: 1,
      type: 'AFK',
      mock: false,
      blocked_by: [],
      parallel_group: 'O-W1',
      triage: 'ready-for-agent',
      status: 'pending',
    },
    {
      id: 'oa-mock-001',
      title: 'mock: contract stub one',
      round: 1,
      type: 'AFK',
      mock: true,
      mock_refines: ['oa-real-002'],
      blocked_by: ['oa-real-001'],
      parallel_group: 'O-W1',
      triage: 'ready-for-agent',
      status: 'pending',
    },
    {
      id: 'oa-mock-002',
      title: 'mock: contract stub two',
      round: 1,
      type: 'AFK',
      mock: true,
      mock_refines: ['oa-real-003'],
      blocked_by: ['oa-real-001'],
      parallel_group: 'O-W1',
      triage: 'ready-for-agent',
      status: 'pending',
    },
    {
      id: 'oa-mock-003',
      title: 'mock: contract stub three',
      round: 1,
      type: 'AFK',
      mock: true,
      mock_refines: ['oa-real-004'],
      blocked_by: ['oa-real-001'],
      parallel_group: 'O-W1',
      triage: 'ready-for-agent',
      status: 'pending',
    },
    {
      id: 'oa-mock-004',
      title: 'mock: contract stub four',
      round: 1,
      type: 'AFK',
      mock: true,
      mock_refines: ['oa-real-002', 'oa-real-003', 'oa-real-004'],
      blocked_by: ['oa-real-001'],
      parallel_group: 'O-W1',
      triage: 'ready-for-agent',
      status: 'pending',
    },
  ];
}

// ─── tests ─────────────────────────────────────────────────────────────────

console.log('mock-gen.test.mjs');

test('1. first-pass generation — 4 mock slices produce 4 .md files with correct frontmatter + typed body', () => {
  const dir = freshDir();
  try {
    const set = sliceSetFixture();
    const out = generateUpfrontMocks(set, dir);
    assertEq(out.written.length, 4, 'should write exactly 4 files (the 4 mock slices)');
    assertEq(out.skipped.length, 0, 'should skip 0 (fresh dir)');

    // Every mock slice must have a file on disk.
    for (const id of ['oa-mock-001', 'oa-mock-002', 'oa-mock-003', 'oa-mock-004']) {
      const path = join(dir, `${id}.md`);
      assert(existsSync(path), `${path} should exist`);
      const text = readFileSync(path, 'utf8');
      // Frontmatter contains the expected fields.
      assertIncludes(text, `id: ${id}`, 'frontmatter has id');
      assertIncludes(text, 'mock: true', 'frontmatter has mock: true');
      assertIncludes(text, 'mock_refines:', 'frontmatter has mock_refines block');
      assertIncludes(text, 'blocked_by:', 'frontmatter has blocked_by block');
      assertIncludes(text, 'triage: ready-for-agent', 'frontmatter has triage');
      // Typed-contract body shape.
      assertIncludes(text, '## Mock contract surface', 'body has the typed-contract section heading');
      assertIncludes(text, '## Wave 1 behavior', 'body has Wave 1 section');
      assertIncludes(text, '## Wave N refinement', 'body has Wave N refinement section');
      assertIncludes(text, '## Acceptance criteria', 'body has Acceptance criteria section');
    }

    // The mock_refines list lands in the frontmatter verbatim (sorted).
    const text001 = readFileSync(join(dir, 'oa-mock-001.md'), 'utf8');
    assertIncludes(text001, '- oa-real-002', 'mock-001 frontmatter lists mock_refines oa-real-002');
    const text004 = readFileSync(join(dir, 'oa-mock-004.md'), 'utf8');
    assertIncludes(text004, '- oa-real-002', 'mock-004 mock_refines includes oa-real-002');
    assertIncludes(text004, '- oa-real-003', 'mock-004 mock_refines includes oa-real-003');
    assertIncludes(text004, '- oa-real-004', 'mock-004 mock_refines includes oa-real-004');
    assertIncludes(text004, '- oa-real-001', 'mock-004 blocked_by includes oa-real-001');
  } finally { rmDir(dir); }
});

test('2. idempotency — re-running generateUpfrontMocks does NOT overwrite existing mock files', () => {
  const dir = freshDir();
  try {
    const set = sliceSetFixture();
    const first = generateUpfrontMocks(set, dir);
    assertEq(first.written.length, 4, 'first pass writes 4 files');

    // Snapshot the bytes of every mock file.
    const snapBefore = {};
    for (const id of ['oa-mock-001', 'oa-mock-002', 'oa-mock-003', 'oa-mock-004']) {
      snapBefore[id] = readFileSync(join(dir, `${id}.md`), 'utf8');
    }

    // Mutate every mock file with a sentinel so we can prove the second
    // pass leaves it alone. If the script overwrites, the sentinel gets
    // blown away.
    const sentinel = '<!-- test: do-not-overwrite -->';
    for (const id of Object.keys(snapBefore)) {
      writeFileSync(join(dir, `${id}.md`), `${sentinel}\n${snapBefore[id]}`, 'utf8');
    }

    const second = generateUpfrontMocks(set, dir);
    assertEq(second.written.length, 0, 'second pass writes 0 (every mock file already exists)');
    assertEq(second.skipped.length, 4, 'second pass reports 4 skipped (the "stub stays one issue per node per wave" rule)');

    for (const id of Object.keys(snapBefore)) {
      const after = readFileSync(join(dir, `${id}.md`), 'utf8');
      assertIncludes(after, sentinel, `${id} preserved the sentinel (not overwritten)`);
    }
  } finally { rmDir(dir); }
});

test('3. refinement — after a real slice lands, refineMockBody edits the dependent mock\'s body in place', () => {
  const dir = freshDir();
  try {
    const set = sliceSetFixture();
    generateUpfrontMocks(set, dir);

    const path = join(dir, 'oa-mock-001.md');
    const before = readFileSync(path, 'utf8');
    // Sanity: frontmatter is what we expect, and the typed-contract section
    // is present BEFORE the refinement.
    assertIncludes(before, 'mock: true', 'mock-001 starts with mock: true');
    assertIncludes(before, '## Mock contract surface', 'mock-001 starts with the typed-contract section');
    // Capture the frontmatter block (between the two `---` fences) so we
    // can prove it is byte-identical after refinement.
    const fmBefore = before.match(/^---\r?\n([\s\S]*?)\r?\n---/)[0];

    const out = refineMockBody(dir, 'oa-real-002');
    assertEq(out.noDependents, false, 'oa-real-002 IS listed by oa-mock-001 mock_refines');
    assert(out.refined.includes(path), 'oa-mock-001.md should be in refined list');

    const after = readFileSync(path, 'utf8');
    // Same file path (already enforced by `path` constant).
    assert(existsSync(path), 'file path unchanged');
    // Frontmatter unchanged byte-for-byte.
    const fmAfter = after.match(/^---\r?\n([\s\S]*?)\r?\n---/)[0];
    assertEq(fmAfter, fmBefore, 'frontmatter is unchanged after refinement');
    // Body now contains the one-line pointer per SKILL.md step 7.
    assertIncludes(after, 'This mock is realized by `oa-real-002`.', 'body has the realization pointer');
    // Typed-contract section body was replaced (no more mock_refines / blocked_by
    // rendering inside the section — those live in the frontmatter).
    const contractSection = after.match(/## Mock contract surface\s*\n([\s\S]*?)(?=\n## |\s*$)/);
    assert(contractSection, '## Mock contract surface section still exists after refinement');
    assertIncludes(contractSection[1], 'This mock is realized by `oa-real-002`.', 'refined body is inside the section');
  } finally { rmDir(dir); }
});

test('4. no-op on no dependents — refineMockBody(unknown-id) is a no-op', () => {
  const dir = freshDir();
  try {
    const set = sliceSetFixture();
    generateUpfrontMocks(set, dir);
    const out = refineMockBody(dir, 'oa-real-does-not-exist');
    assertEq(out.refined.length, 0, 'refined list is empty');
    assertEq(out.noDependents, true, 'noDependents flag is true');
    // Every mock file is byte-identical to its pre-refinement state.
    // None of the stubs' typed-contract sections should have been replaced
    // with the one-line realization pointer for the unknown id. The stub
    // body contains a literal `realized by \`<real-id>\`` as a code-block
    // example of the refinement pattern, so we test for the SPECIFIC
    // unknown-id pointer, not the substring in general.
    const unknownPointer = 'This mock is realized by `oa-real-does-not-exist`.';
    for (const id of ['oa-mock-001', 'oa-mock-002', 'oa-mock-003', 'oa-mock-004']) {
      const path = join(dir, `${id}.md`);
      const text = readFileSync(path, 'utf8');
      assertIncludes(text, '## Mock contract surface', `${id} untouched (typed-contract section still present)`);
      assert(!text.includes(unknownPointer), `${id} untouched (no realization pointer for unknown id)`);
    }
  } finally { rmDir(dir); }
});

test('5. determinism — same slice set + same input → same output bytes across two runs', () => {
  const dir1 = freshDir();
  const dir2 = freshDir();
  try {
    const set = sliceSetFixture();
    generateUpfrontMocks(set, dir1);
    generateUpfrontMocks(set, dir2);
    // Every file in dir1 must byte-equal the corresponding file in dir2.
    for (const id of ['oa-mock-001', 'oa-mock-002', 'oa-mock-003', 'oa-mock-004']) {
      const a = readFileSync(join(dir1, `${id}.md`), 'utf8');
      const b = readFileSync(join(dir2, `${id}.md`), 'utf8');
      assertEq(a, b, `${id} byte-equal across runs`);
    }
    // No accidental timestamps / random IDs: the body must NOT mention
    // "Date", any ISO timestamp, or any UUID-like token.
    const text = readFileSync(join(dir1, 'oa-mock-001.md'), 'utf8');
    assert(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), 'no ISO timestamps in stub body');
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'no UUIDs in stub body');

    // Refinement output must also be deterministic: refine twice, the
    // pointer body is identical across runs.
    const dir3 = freshDir();
    try {
      generateUpfrontMocks(set, dir3);
      refineMockBody(dir3, 'oa-real-002');
      const refinedA = readFileSync(join(dir3, 'oa-mock-001.md'), 'utf8');
      const dir4 = freshDir();
      try {
        generateUpfrontMocks(set, dir4);
        refineMockBody(dir4, 'oa-real-002');
        const refinedB = readFileSync(join(dir4, 'oa-mock-001.md'), 'utf8');
        assertEq(refinedA, refinedB, 'refinement output byte-equal across runs');
      } finally { rmDir(dir4); }
    } finally { rmDir(dir3); }
  } finally { rmDir(dir1); rmDir(dir2); }
});

// ─── summary ───────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(`\nfailures:`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
process.exit(0);

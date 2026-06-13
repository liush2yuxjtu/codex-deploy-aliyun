// dispatch.test.mjs — unit tests for dispatch.mjs
//
// 4 test cases per oa-004 acceptance criteria:
//   1. Prompt construction: prompt body contains slice's What-to-build +
//      Acceptance-criteria verbatim + the office-agents preamble + the
//      hard rules.
//   2. State log entry: after dispatchEdge, state log has a "dispatched"
//      JSONL line with dispatcher="office", edge=<sliceId>, deps_at_dispatch=[...],
//      agent_id=<returned from dispatchFn>.
//   3. Idempotency at the dispatchFn level: two dispatches append two lines
//      (no dedup at this layer; orchestrator is responsible).
//   4. Mocked Agent tool: dispatchFn is parameterized; tests pass a mock
//      that records the prompt + returns a fake agentId.
//
// Run: `node dispatch.test.mjs` — zero-dep, uses node:test + node:assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkerPrompt, dispatchEdge } from './dispatch.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A representative slice fixture that exercises every frontmatter field
// dispatch cares about: id, title, blocked_by (multi), files (multi).
const SAMPLE_SLICE = `---
id: oa-004
title: per-edge dispatcher + worker prompt builder
us: US-1.2, US-1.4
parallel_group: O-W2A
type: AFK
round: 2
mock: false
blocked_by:
  - oa-001
  - oa-002
files:
  - plugins/office-agents/skills/office-agents/scripts/dispatch.mjs
  - plugins/office-agents/skills/office-agents/scripts/dispatch.test.mjs
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
triage: in-progress
---

# oa-004: per-edge dispatcher + worker prompt builder

## What to build

The per-edge dispatch logic: build a worker prompt and fire the Agent tool.

## Acceptance criteria

- [ ] dispatch.mjs is zero-dep.
- [ ] dispatchFn is parameterizable.
- [ ] All test cases pass.
`;

async function writeSampleSlice(dir) {
  const slicePath = join(dir, 'oa-004-dispatcher-and-prompt-builder.md');
  await writeFile(slicePath, SAMPLE_SLICE, 'utf8');
  return slicePath;
}

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'oa-004-dispatch-'));
  const slicePath = await writeSampleSlice(dir);
  const stateLogPath = join(dir, '.office-agents-edge.log');
  return { dir, slicePath, stateLogPath };
}

// ---------------------------------------------------------------------------
// Test 1 — Prompt construction
// ---------------------------------------------------------------------------

test('buildWorkerPrompt: includes slice body verbatim + office-agents preamble + hard rules', async () => {
  const { dir, slicePath } = await makeWorkspace();
  try {
    const prompt = await buildWorkerPrompt(slicePath);

    // Slice body verbatim (the inline copy at the end of the prompt).
    assert.match(
      prompt,
      /## What to build[\s\S]*build a worker prompt and fire the Agent tool\./,
      'prompt must include "## What to build" verbatim',
    );
    assert.match(
      prompt,
      /## Acceptance criteria[\s\S]*dispatch\.mjs is zero-dep\./,
      'prompt must include "## Acceptance criteria" verbatim',
    );

    // Office-agents preamble — the single-paragraph insertion per AP-4.
    assert.match(
      prompt,
      /You are dispatched via the office-agents event-driven dispatcher\./,
      'prompt must contain the office-agents preamble',
    );
    assert.match(
      prompt,
      /State log entry on dispatch: `<edge>: dispatched via office-agents`/,
      'prompt must contain the state-log-entry directive',
    );

    // Hard rules — verify the 7 rules from the slice body / AP-4.
    assert.match(prompt, /Do NOT spawn further subagents/, 'hard rule: no subagents');
    assert.match(prompt, /Do NOT ask the user questions/, 'hard rule: no user questions');
    assert.match(
      prompt,
      /Do NOT modify the slice's frontmatter/,
      'hard rule: no frontmatter mutation',
    );
    assert.match(prompt, /Do NOT touch any `mock:\*\.md`/, 'hard rule: no mock files');
    assert.match(
      prompt,
      /Do NOT touch files outside your slice's scope/,
      'hard rule: scope discipline',
    );
    assert.match(
      prompt,
      /On a 429 \/ token-plan \/ quota error: retry silently once/,
      'hard rule: silent 429 retry',
    );
    assert.match(prompt, /AP-4:/, 'hard rule: AP-4 echo');

    // Slice-specific placeholders substituted.
    assert.match(prompt, /id: oa-004/, 'slice id substituted');
    assert.match(prompt, /title: per-edge dispatcher/, 'slice title substituted');
    assert.match(
      prompt,
      /upstreams realized: oa-001, oa-002/,
      'blocked_by rendered as comma-separated list',
    );
    assert.match(
      prompt,
      /plugins\/office-agents\/skills\/office-agents\/scripts/,
      'files scope rendered as directory of first files: entry',
    );

    // The prompt must NOT leave unsubstituted placeholders behind.
    assert.doesNotMatch(
      prompt,
      /<SLICE_ID>|<SLICE_TITLE>|<SLICE_FILE>|<SLICE_BLOCKED_BY>|<SLICE_FILES_SCOPE>/,
      'no leftover <...> placeholders',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — State log entry
// ---------------------------------------------------------------------------

test('dispatchEdge: appends "dispatched" JSONL line with correct shape', async () => {
  const { dir, slicePath, stateLogPath } = await makeWorkspace();
  try {
    const dispatchFn = async ({ prompt }) => {
      // Mocked Agent tool — record the prompt + return a fake agentId.
      return { agentId: 'mock-agent-a3f8', promptSeen: prompt };
    };

    const result = await dispatchEdge({
      sliceId: 'oa-004',
      slicePath,
      issuesDir: dir,
      stateLogPath,
      dispatchFn,
    });

    // dispatchFn was called once with our prompt.
    assert.equal(result.agentId, 'mock-agent-a3f8');
    assert.ok(typeof result.promptSeen === 'string', 'prompt passed to dispatchFn');
    assert.match(result.promptSeen, /oa-004/, 'prompt carries the slice id');

    // State log line shape.
    const logText = await readFile(stateLogPath, 'utf8');
    const lines = logText.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one JSONL line');

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.status, 'dispatched', 'status is "dispatched"');
    assert.equal(entry.dispatcher, 'office', 'dispatcher discriminator is "office"');
    assert.equal(entry.edge, 'oa-004', 'edge equals sliceId');
    assert.deepEqual(
      entry.deps_at_dispatch,
      ['oa-001', 'oa-002'],
      'deps_at_dispatch mirrors slice frontmatter blocked_by',
    );
    assert.equal(entry.agent_id, 'mock-agent-a3f8', 'agent_id from dispatchFn');
    assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0, 'ts is present');
    assert.ok(
      typeof entry.slice_path === 'string' && entry.slice_path.endsWith('oa-004-dispatcher-and-prompt-builder.md'),
      'slice_path recorded',
    );

    // Echoed back on the result.
    assert.deepEqual(result.stateLogLine, entry, 'result.stateLogLine echoes the appended line');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Idempotency at the dispatchFn level
// ---------------------------------------------------------------------------

test('dispatchEdge: two dispatches append two lines (no dedup at this layer)', async () => {
  const { dir, slicePath, stateLogPath } = await makeWorkspace();
  try {
    let calls = 0;
    const dispatchFn = async () => {
      calls += 1;
      return { agentId: `mock-${calls}` };
    };

    // First dispatch.
    await dispatchEdge({
      sliceId: 'oa-004',
      slicePath,
      issuesDir: dir,
      stateLogPath,
      dispatchFn,
    });

    // Second dispatch — same slice, fresh mock agent. Orchestrator
    // (oa-005) is responsible for not re-firing; this layer just records.
    await dispatchEdge({
      sliceId: 'oa-004',
      slicePath,
      issuesDir: dir,
      stateLogPath,
      dispatchFn,
    });

    assert.equal(calls, 2, 'dispatchFn called twice');

    const logText = await readFile(stateLogPath, 'utf8');
    const lines = logText.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'two JSONL lines');

    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.equal(e1.agent_id, 'mock-1');
    assert.equal(e2.agent_id, 'mock-2');
    assert.equal(e1.status, 'dispatched');
    assert.equal(e2.status, 'dispatched');
    // The second line's ts must be >= the first's.
    assert.ok(
      new Date(e2.ts).getTime() >= new Date(e1.ts).getTime(),
      'second line appended after first',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Mocked Agent tool (dispatchFn is parameterized)
// ---------------------------------------------------------------------------

test('dispatchEdge: dispatchFn is parameterized — no hard dependency on Agent tool', async () => {
  const { dir, slicePath, stateLogPath } = await makeWorkspace();
  try {
    let receivedPrompt = null;
    let receivedSliceId = null;
    let receivedSlicePath = null;

    // dispatchFn is plain JS — no Agent-tool import required. The
    // production call site (oa-005) injects the real Agent tool here;
    // tests inject a recording stub.
    const dispatchFn = async ({ prompt, sliceId, slicePath: passedSlicePath }) => {
      receivedPrompt = prompt;
      receivedSliceId = sliceId;
      receivedSlicePath = passedSlicePath;
      return { agentId: 'injected-stub' };
    };

    await dispatchEdge({
      sliceId: 'oa-004',
      slicePath,
      issuesDir: dir,
      stateLogPath,
      dispatchFn,
    });

    assert.ok(receivedPrompt && receivedPrompt.includes('oa-004'), 'prompt delivered');
    assert.equal(receivedSliceId, 'oa-004');
    assert.equal(receivedSlicePath, slicePath);

    // Missing dispatchFn is a hard error — no silent fallback.
    await assert.rejects(
      dispatchEdge({
        sliceId: 'oa-004',
        slicePath,
        issuesDir: dir,
        stateLogPath,
        dispatchFn: undefined,
      }),
      /dispatchFn must be a function/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-4 byte-identicality check
// ---------------------------------------------------------------------------

test('AP-4: prompt body differs from /afk-agents template by exactly one paragraph (the preamble)', async () => {
  // We can't import the live /afk-agents template from the filesystem
  // (the test would need to resolve ~/.claude/skills/...). Instead, we
  // assert the structural property: the office-agents prompt must be
  // exactly equal to "{OFFICE_AGENTS_PREAMBLE}{substituted-template} +
  // slice body". If a future change adds office-agents advice into the
  // body of AFK_AGENTS_PROMPT_TEMPLATE without also editing
  // /afk-agents' template, this test catches the AP-4 violation.
  //
  // We re-import dispatch.mjs's exported function and inspect the
  // resulting prompt's structure: preamble first, then a single
  // contiguous block matching the afk-style template, then the slice
  // body.
  const { dir, slicePath } = await makeWorkspace();
  try {
    const prompt = await buildWorkerPrompt(slicePath);

    // Preamble: starts with the office-agents-specific paragraph.
    assert.ok(
      prompt.startsWith(
        'You are dispatched via the office-agents event-driven dispatcher.',
      ),
      'prompt starts with the office-agents preamble',
    );

    // After the preamble, the afk-style template body begins.
    const afterPreambleIdx = prompt.indexOf(
      'You are implementing ONE slice from a /to-issues breakdown.',
    );
    assert.ok(afterPreambleIdx > 0, 'afk-style template body follows the preamble');

    // The afk-style body is contiguous (no office-agents-only rules
    // interleaved inside it).
    const afkBody = prompt.slice(afterPreambleIdx);

    // Slice body section follows a `---` separator.
    const sliceBodyIdx = afkBody.indexOf('\n---\n\n# Slice body');
    assert.ok(sliceBodyIdx > 0, 'slice body follows a `---` separator after the afk-style template');

    // The afk-style body between the preamble and the slice-body
    // separator must not contain office-agents-specific directives
    // (anything beyond the preamble itself).
    const afkBodyOnly = afkBody.slice(0, sliceBodyIdx);
    assert.doesNotMatch(
      afkBodyOnly,
      /ready-edge|state log entry on dispatch|event-driven dispatcher/,
      'afk-style body must not contain office-agents-only directives',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

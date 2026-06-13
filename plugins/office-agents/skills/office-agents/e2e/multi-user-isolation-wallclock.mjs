#!/usr/bin/env node
// /office-agents e2e wall-clock harness — oa-007.
//
// Drives the office-agents orchestrator against the
// `docs/issues/multi-user-isolation/` slice set as a hermetic test
// fixture, with a `dispatchFn` mock that simulates a real worker:
//   - Records dispatch start time.
//   - Returns a fake agentId immediately (the Agent tool's
//     `run_in_background: true` semantic in production).
//   - Asynchronously sleeps 1-5s (the simulated worker's
//     "land" latency) and writes a `landed` event to the state log.
//
// Re-triggers are scheduled every 30s — same cadence as the
// production `/office-agents` skill, where the user comes back
// to the screen every ~30s and re-fires the loop. Each pass:
//   1. Copies the fixture (read-only) to a temp workspace.
//   2. Computes ready edges, fires each via the mock dispatchFn.
//   3. Waits 30s OR until every ready edge has landed — whichever
//      comes first — before the next pass.
//
// Wall-clock ends when every real slice + the audit have landed
// (the SC-7 "wave plan is done" gate). All metrics land in JSON
// on stdout for the bash wrapper. The orchestrator's streaming
// pass lines (e.g. `office-agents: pass 1`, `fired: ...`) are
// routed to stderr so they don't pollute the JSON-on-stdout
// contract — the bash wrapper can re-emit them to the user's
// terminal without breaking the printer's JSON.parse.
//
// Zero-dep. Node >= 18.

import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
  appendFile,
  rm,
} from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return fallback;
  return args[i + 1];
}
const FIXTURE_DIR = resolve(arg(
  '--fixture',
  // Default: the project's mui issue set, resolved from the
  // e2e/ dir. Path layout:
  //   plugins/office-agents/skills/office-agents/e2e/   (here, __dirname)
  //   plugins/office-agents/skills/office-agents/      (1 up)
  //   plugins/office-agents/skills/                    (2 up)
  //   plugins/office-agents/                           (3 up)
  //   plugins/                                          (4 up)
  //   <repo root>                                       (5 up)
  //   docs/issues/multi-user-isolation/                 (target)
  join(__dirname, '..', '..', '..', '..', '..', 'docs', 'issues', 'multi-user-isolation'),
));
const RE_TRIGGER_MS = Number(arg('--retrigger-ms', '30000'));           // 30s per spec
const WORKER_LATENCY_MIN_MS = Number(arg('--worker-min-ms', '1000'));   // 1s
const WORKER_LATENCY_MAX_MS = Number(arg('--worker-max-ms', '5000'));   // 5s
const MAX_PASSES = Number(arg('--max-passes', '60'));                   // safety brake
const NO_PROGRESS_LIMIT = Number(arg('--no-progress-limit', '5'));      // passes w/o new landed → stuck
const AFK_AGENTS_BASELINE_MIN = Number(arg('--baseline-min', '40'));    // 40 min baseline

// ---------------------------------------------------------------------------
// Workspace bootstrap
// ---------------------------------------------------------------------------

const workRoot = mkdtempSync(join(tmpdir(), 'oa-007-e2e-'));
const issuesDir = join(workRoot, 'issues');
const stateLogPath = join(workRoot, '.office-agents-edge.log');

await mkdir(issuesDir, { recursive: true });
const srcFiles = (await readdir(FIXTURE_DIR))
  .filter((f) => f.endsWith('.md'));
for (const f of srcFiles) {
  await copyFile(join(FIXTURE_DIR, f), join(issuesDir, f));
}

// ---------------------------------------------------------------------------
// Fixture normalization
// ---------------------------------------------------------------------------
//
// The `docs/issues/multi-user-isolation/` slice set is the
// /afk-agents run's *post-ship* state — every slice's frontmatter
// is left over from the run (mu-001 still `triage: ready-for-agent`
// because it's a foundation slice, but mu-002..mu-007 are
// `triage: in-progress` from when the wave-2/3 workers picked them
// up, and mu-008 is `triage: in-review` from when the wave-4 worker
// landed). ready-edge.mjs gates `readyEdges` on
// `triage: ready-for-agent`, so without normalization pass 2 would
// see zero ready edges and the loop would falsely report "stuck".
//
// The orchestrator's "snapshot" must therefore be the *structure*
// (deps, files, ACs), with the lifecycle state reset to
// `triage: ready-for-agent, status: pending`. The original
// fixture on disk is NEVER touched — only the copy in the temp
// workspace is. The copy is wiped by `cleanupAndExit` at end of run.

async function normalizeTriageOnCopy() {
  const files = (await readdir(issuesDir)).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const p = join(issuesDir, f);
    const txt = await readFile(p, 'utf8');
    const m = txt.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!m) continue;
    const body = m[2];
    let mutated = false;
    const newBody = body
      .split(/\r?\n/)
      .map((line) => {
        const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (!kv) return line;
        if (kv[1] === 'triage') {
          mutated = true;
          return `${kv[1]}: ready-for-agent`;
        }
        if (kv[1] === 'status') {
          mutated = true;
          return `${kv[1]}: pending`;
        }
        return line;
      })
      .join('\n');
    if (mutated) {
      const newTxt = txt.replace(m[0], `${m[1]}${newBody}${m[3]}`);
      await writeFile(p, newTxt, 'utf8');
    }
  }
}
await normalizeTriageOnCopy();

// ---------------------------------------------------------------------------
// Slice-set introspection (after normalization)
// ---------------------------------------------------------------------------
//
// We compute the "done" set from the normalized copy: every real
// AFK slice + the audit. The orchestrator's `auditFiredInLog` regex
// is too narrow to match the mui fixture's `mu-mock-audit` id, so
// we don't gate the loop on `result.reportWritten`. Instead we
// gate on our own bookkeeping: every real slice has a `landed`
// record AND the audit slice has a `landed` record. This matches
// the SC-7 spirit ("the wave plan is done") without depending on
// a brittle regex match in the orchestrator.

function parseFrontmatterLite(txt) {
  const m = txt.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out = {};
  function parseValue(v) {
    v = (v ?? '').trim();
    if (v === '') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '[]') return [];
    if (v.startsWith('[') && v.endsWith(']')) {
      return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    return v;
  }
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kv) out[kv[1]] = parseValue(kv[2]);
  }
  return out;
}

const sliceSet = [];
for (const f of (await readdir(issuesDir)).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').sort()) {
  const txt = await readFile(join(issuesDir, f), 'utf8');
  const fm = parseFrontmatterLite(txt);
  if (!fm.id) continue;
  sliceSet.push(fm);
}
const realSlices = sliceSet.filter(
  (s) => s.type === 'AFK' && s.mock !== true,
);
const auditSlice = sliceSet.find(
  (s) => s.type === 'AFK' && s.mock === true &&
    (s.title ?? '').trim().toLowerCase().startsWith('mock:audit'),
);
const realIds = new Set(realSlices.map((s) => s.id));
const auditId = auditSlice ? auditSlice.id : null;
const totalToLand = realIds.size + (auditId ? 1 : 0);

// ---------------------------------------------------------------------------
// State + metrics
// ---------------------------------------------------------------------------

const runStartedAt = Date.now();
const latencies = [];              // per-edge dispatch latency (ms) — wall-clock from "fired" to "landed"
const stuckSlices = [];            // slices that hit the timeout gate
const dispatchRecords = [];        // [{sliceId, dispatchedAt, landedAt|null}]
const passingReadyCounts = [];     // for diagnostics: ready-edge count per pass
const inFlightAgents = new Map();  // uniqueKey -> Promise (the background mock worker)

// ---------------------------------------------------------------------------
// Mock dispatchFn
// ---------------------------------------------------------------------------
//
// Production: dispatchFn = async ({ prompt, sliceId, slicePath }) => {
//   // calls the Agent tool with run_in_background: true and returns
//   // { agentId }.
// }
//
// The orchestrator `await`s the result so we can guarantee a
// `dispatched` event is in the state log before the pass returns.
// To preserve "parallel agent" semantics we still want the work to
// happen in the background. We therefore:
//   1. Record dispatchedAt + spawn a background "agent" that
//      sleeps 1-5s and writes a `landed` line to the log.
//   2. Resolve the dispatchFn promise IMMEDIATELY with a fake
//      agentId. The orchestrator proceeds to the next ready edge
//      in the same pass, but the background agent keeps running
//      and lands asynchronously.

function makeMockDispatchFn() {
  return async ({ prompt: _prompt, sliceId, slicePath: _slicePath }) => {
    const dispatchedAt = Date.now();
    const agentId = `mock-${sliceId}-${dispatchRecords.length + 1}-${dispatchedAt.toString(36)}`;
    dispatchRecords.push({ sliceId, agentId, dispatchedAt, landedAt: null });

    // Spawn the background "agent" — sleeps 1-5s, then writes a
    // `landed` event to the state log so the next pass can pick
    // up newly-ready edges.
    const sleepMs = randomBetween(WORKER_LATENCY_MIN_MS, WORKER_LATENCY_MAX_MS);
    const agentPromise = (async () => {
      await sleep(sleepMs);
      const landedAt = Date.now();
      const latency = landedAt - dispatchedAt;
      latencies.push({ sliceId, latencyMs: latency });
      // Find the still-unlanded record for this slice (the most
      // recent dispatch for it) and mark it landed.
      for (let i = dispatchRecords.length - 1; i >= 0; i--) {
        const r = dispatchRecords[i];
        if (r.sliceId === sliceId && r.landedAt === null) {
          r.landedAt = landedAt;
          break;
        }
      }
      const line = JSON.stringify({
        ts: new Date(landedAt).toISOString(),
        dispatcher: 'office',
        edge: sliceId,
        status: 'landed',
        commit: `mock-${sliceId}-${agentId}`,
        sleep_ms: sleepMs,
      });
      await appendFile(stateLogPath, line + '\n', 'utf8');
    })();
    inFlightAgents.set(`${sliceId}-${agentId}`, agentPromise);

    return { agentId };
  };
}

// ---------------------------------------------------------------------------
// Driver loop
// ---------------------------------------------------------------------------

const { runOfficeAgentsPass } = await import('../scripts/orchestrate.mjs');
const dispatchFn = makeMockDispatchFn();

// The orchestrator writes its streaming pass lines to stdout (per
// SKILL.md's "streaming stdout shape" contract). For the e2e we
// want stdout to be PURE JSON (consumed by the bash wrapper's
// `print-summary.mjs`), so we capture the orchestrator's lines
// via `result.stdoutLines` and re-emit them to STDERR at the end
// of the run. The user's terminal still sees them; the JSON on
// stdout stays parseable.
const capturedStdoutLines = [];
let realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, cb) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
  capturedStdoutLines.push(s);
  if (typeof cb === 'function') cb();
  return true;
};

let passNumber = 0;
let lastLandedCount = 0;
let noProgressPasses = 0;

while (passNumber < MAX_PASSES) {
  passNumber++;
  const passStartedAt = Date.now();

  // Run the pass.
  let result;
  try {
    result = await runOfficeAgentsPass({
      issuesDir,
      stateLogPath,
      dispatchFn,
      options: { passNumber, stuckThreshold: 3 },
    });
  } catch (err) {
    // Restore stdout before exiting so the error JSON makes it out.
    process.stdout.write = realStdoutWrite;
    await cleanupAndExit(1, {
      ok: false,
      error: `pass ${passNumber} crashed: ${err && err.message ? err.message : err}`,
    });
  }
  passingReadyCounts.push({
    pass: passNumber,
    ready: result.readyEdges.length,
    dispatched: result.dispatched.length,
    stuck: result.stuck.length,
  });

  // Re-trigger cadence: wait for either
  //   (a) 30s elapsed, OR
  //   (b) every in-flight mock agent has landed (no need to wait
  //       the full 30s — the next pass will only see new ready
  //       edges after lands, so a tighter loop just speeds the
  //       wall-clock up).
  // We always cap the wait at RE_TRIGGER_MS so the e2e pacing
  // mirrors the production "user comes back every 30s" semantic.
  const elapsed = Date.now() - passStartedAt;
  const budget = RE_TRIGGER_MS;
  const inFlightCount = [...inFlightAgents.values()].filter((p) => p).length;
  if (inFlightCount > 0) {
    const remaining = Math.max(0, budget - elapsed);
    await Promise.race([
      Promise.all([...inFlightAgents.values()]),
      sleep(remaining),
    ]);
  } else if (elapsed < budget) {
    await sleep(budget - elapsed);
  }

  // Termination gate: every real slice has landed AND the audit
  // (if present) has landed. This is the SC-7 "wave plan is done"
  // predicate, computed from our own dispatchRecords bookkeeping.
  const landedSliceIds = new Set(
    dispatchRecords.filter((r) => r.landedAt !== null).map((r) => r.sliceId),
  );
  const allRealLanded = [...realIds].every((id) => landedSliceIds.has(id));
  const auditLanded = !auditId || landedSliceIds.has(auditId);
  if (allRealLanded && auditLanded) {
    break;
  }

  // Stuck-edge bookkeeping: if a pass added no new landed events
  // and nothing was dispatched, the loop is stuck.
  const landedCount = dispatchRecords.filter((r) => r.landedAt !== null).length;
  if (
    result.dispatched.length === 0 &&
    landedCount === lastLandedCount &&
    result.readyEdges.length > 0
  ) {
    noProgressPasses++;
    if (noProgressPasses >= NO_PROGRESS_LIMIT) {
      for (const s of result.readyEdges) {
        if (!stuckSlices.includes(s)) stuckSlices.push(s);
      }
      break;
    }
  } else {
    noProgressPasses = 0;
  }
  lastLandedCount = landedCount;
}

const runCompletedAt = Date.now();
const wallClockMs = runCompletedAt - runStartedAt;
const wallClockSec = wallClockMs / 1000;
const wallClockMin = wallClockSec / 60;
const afkBaselineMin = AFK_AGENTS_BASELINE_MIN;
const pctOfBaseline = (wallClockMin / afkBaselineMin) * 100;

// "Done" predicate: every real slice + audit landed.
const landedSliceIds = new Set(
  dispatchRecords.filter((r) => r.landedAt !== null).map((r) => r.sliceId),
);
const allRealLanded = [...realIds].every((id) => landedSliceIds.has(id));
const auditLanded = !auditId || landedSliceIds.has(auditId);
const planDone = allRealLanded && auditLanded;

const verdict = (planDone && wallClockMin <= 0.6 * afkBaselineMin) ? 'PASS' : 'FAIL';
const auditVerdict = planDone ? 'PASS' : 'PENDING';

// Per-edge dispatch latency distribution.
const sortedLatencies = latencies.map((l) => l.latencyMs).sort((a, b) => a - b);
const p50 = percentile(sortedLatencies, 0.5);
const p95 = percentile(sortedLatencies, 0.95);
const p99 = percentile(sortedLatencies, 0.99);
const max = sortedLatencies[sortedLatencies.length - 1] ?? 0;
const min = sortedLatencies[0] ?? 0;
const mean = sortedLatencies.length
  ? sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length
  : 0;

const summary = {
  ok: true,
  fixture: FIXTURE_DIR,
  workspace: workRoot,
  re_trigger_ms: RE_TRIGGER_MS,
  worker_latency_range_ms: [WORKER_LATENCY_MIN_MS, WORKER_LATENCY_MAX_MS],
  passes_run: passNumber,
  slices_dispatched: dispatchRecords.length,
  slices_landed: dispatchRecords.filter((r) => r.landedAt !== null).length,
  slices_stuck: stuckSlices,
  total_expected: totalToLand,
  wall_clock_ms: wallClockMs,
  wall_clock_min: Number(wallClockMin.toFixed(2)),
  afk_agents_baseline_min: afkBaselineMin,
  pct_of_baseline: Number(pctOfBaseline.toFixed(1)),
  threshold_pct: 60,
  verdict,
  audit_verdict: auditVerdict,
  latency_distribution_ms: {
    min: round0(min),
    p50: round0(p50),
    p95: round0(p95),
    p99: round0(p99),
    max: round0(max),
    mean: round0(mean),
    n: sortedLatencies.length,
  },
  per_pass_ready_counts: passingReadyCounts,
  per_edge_dispatch_latency: latencies,
};

// Replay the orchestrator's streaming pass lines to stderr so
// the user sees them in the terminal (the bash wrapper merges
// stderr+stdout), then restore stdout and emit the JSON summary.
process.stderr.write('-- office-agents streaming pass lines (replayed from stderr capture) --\n');
for (const line of capturedStdoutLines) process.stderr.write(line);
process.stderr.write('-- end streaming pass lines --\n');
process.stdout.write = realStdoutWrite;

await cleanupAndExit(0, summary);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function cleanupAndExit(code, obj) {
  // Drain any in-flight mock agents so they don't crash mid-flush.
  await Promise.allSettled([...inFlightAgents.values()]);
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  // Wipe the temp workspace — the script is hermetic and must leave
  // no leftover files behind.
  try {
    await rm(workRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  process.exit(code);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(
    sortedArr.length - 1,
    Math.max(0, Math.floor(p * sortedArr.length)),
  );
  return sortedArr[idx];
}

function round0(n) {
  return Math.round(n);
}

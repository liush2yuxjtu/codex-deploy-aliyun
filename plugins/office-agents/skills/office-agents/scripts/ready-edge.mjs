#!/usr/bin/env node
// /office-agents ready-edge — compute ready edges from slice set + state log.
// Zero npm deps. Node >= 18. Run: `node ready-edge.mjs <issues-dir> [<state-log-path>]`
//
// Reads the issue set (INDEX.md + every *.md frontmatter) and the append-only
// JSONL state log, then emits the ready edges (real slices whose blocked_by is
// satisfied AND who haven't been dispatched yet) as JSON to stdout. The shape:
//
//   {"readyEdges": [...], "inFlight": [...], "stuck": [...], "allLanded": bool, "auditReady": bool}
//
// Failure modes (mirror to-issues/scripts/build.mjs):
//   - no slices in dir                  -> exit 1
//   - missing INDEX.md                  -> ok, no source-hint, no warn
//   - missing frontmatter on a slice    -> skip + stderr warn
//   - dangling blocked_by reference     -> drop edge + stderr warn
//   - cycle in blocked_by               -> DFS detect + stderr warn
//   - malformed JSONL line in state log -> skip + stderr warn, do not crash
//
// Idempotent: same inputs -> same output. Deterministic ordering: alphabetical
// for readyEdges / inFlight / stuck.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── args
const issuesDir = resolve(process.argv[2] ?? './.agent/issues');
const stateLogPath = resolve(process.argv[3] ?? join(issuesDir, '.office-agents-edge.log'));

if (!statSafe(issuesDir)) {
  console.error(`✗ ready-edge: issues dir not found: ${issuesDir}`);
  console.error(`  usage: node ready-edge.mjs <issues-dir> [<state-log-path>]`);
  process.exit(1);
}

// ─── read source
const indexText = readText(join(issuesDir, 'INDEX.md'));           // optional, source-hint only
const allFiles = readdirSync(issuesDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md').sort();
const rawSlices = allFiles.map(f => parseIssue(join(issuesDir, f), f));
const slices = rawSlices.filter(s => s.id && s.title);
const dropped = rawSlices.filter(s => !s.id || !s.title);
for (const d of dropped) console.error(`⚠ ready-edge: dropped ${d.file} (no id/title in frontmatter)`);

if (slices.length === 0) {
  console.error(`✗ ready-edge: no slices with id+title found in ${issuesDir}`);
  process.exit(1);
}

// ─── read state log (JSONL, append-only)
const stateLogLines = readText(stateLogPath).split(/\r?\n/).filter(Boolean);
const dispatchedOrLandedIds = new Set();
const inFlightIds = new Set();        // edges that are currently dispatched but not yet landed
const landedIds = new Set();
for (let i = 0; i < stateLogLines.length; i++) {
  const raw = stateLogLines[i];
  let evt;
  try { evt = JSON.parse(raw); }
  catch { console.error(`⚠ ready-edge: state-log line ${i + 1} malformed JSON, skipped`); continue; }
  if (!evt || typeof evt !== 'object') { console.error(`⚠ ready-edge: state-log line ${i + 1} not an object, skipped`); continue; }
  // filter to this dispatcher (office); tolerate older afk-agents log lines by keeping them inert
  if (evt.dispatcher && evt.dispatcher !== 'office') continue;
  if (!evt.edge || !evt.status) continue;
  if (evt.status === 'dispatched') {
    dispatchedOrLandedIds.add(evt.edge);
    inFlightIds.add(evt.edge);
  } else if (evt.status === 'landed') {
    dispatchedOrLandedIds.add(evt.edge);
    landedIds.add(evt.edge);
    inFlightIds.delete(evt.edge);
  }
}

// ─── build maps
const byId = new Map(slices.map(s => [s.id, s]));
const mockStubIds = new Set(slices.filter(s => s.mock === true).map(s => s.id));

// ─── dangling-edge check (warn only, don't drop from blocked_by)
for (const s of slices) for (const dep of s.blocked_by ?? []) {
  if (!byId.has(dep)) console.error(`⚠ ready-edge: ${s.id}.blocked_by references unknown id "${dep}" (dangling — will be ignored)`);
}

// ─── cycle detection (DFS three-color)
const COLOR = { WHITE: 0, GRAY: 1, BLACK: 2 };
const color = new Map(slices.map(s => [s.id, COLOR.WHITE]));
const cycles = [];
function dfs(id, stack) {
  color.set(id, COLOR.GRAY);
  stack.push(id);
  for (const dep of byId.get(id)?.blocked_by ?? []) {
    if (!byId.has(dep)) continue;                // dangling edges don't participate in cycle detection
    if (color.get(dep) === COLOR.GRAY) {
      const idx = stack.indexOf(dep);
      cycles.push(stack.slice(idx).concat(dep).join(' -> '));
    } else if (color.get(dep) === COLOR.WHITE) {
      dfs(dep, stack);
    }
  }
  stack.pop();
  color.set(id, COLOR.BLACK);
}
for (const s of slices) if (color.get(s.id) === COLOR.WHITE) dfs(s.id, []);
for (const c of cycles) console.error(`⚠ ready-edge: cycle: ${c}`);

// ─── compute ready edges / in-flight / stuck / all-landed / audit-ready
const satisfiedSet = (b) => dispatchedOrLandedIds.has(b) || mockStubIds.has(b);

const readyEdges = [];
const inFlight = [];
const stuck = [];
let realCount = 0;            // non-mock AFK slices
let realLandedCount = 0;
let mockAuditId = null;

for (const s of slices) {
  // in-flight = real AFK slice currently dispatched but not yet landed
  if (s.type === 'AFK' && s.mock !== true && inFlightIds.has(s.id)) {
    inFlight.push(s.id);
  }
  if (s.mock !== true && s.type === 'AFK') {
    realCount++;
    if (landedIds.has(s.id)) realLandedCount++;
  }
  // ready = real AFK, not yet dispatched, blocked_by all satisfied
  if (s.type === 'AFK' && s.mock !== true && !dispatchedOrLandedIds.has(s.id)) {
    const deps = s.blocked_by ?? [];
    const ready = deps.every(satisfiedSet);
    if (ready && (s.triage ?? 'ready-for-agent') === 'ready-for-agent') {
      readyEdges.push(s.id);
    }
  }
  // mock-audit detection: by title prefix `mock:audit`
  if (s.mock === true && (s.title ?? '').trim().toLowerCase().startsWith('mock:audit')) {
    mockAuditId = s.id;
  }
}

// if auditReady and audit slice not yet dispatched, surface it as a ready
// edge — even though it's a mock slice, it's the one-shot audit the
// orchestrator must fire when every real slice has landed.
if (mockAuditId && !dispatchedOrLandedIds.has(mockAuditId)) {
  readyEdges.push(mockAuditId);
}

// structural-stuck (v1): a real AFK slice whose blocked_by contains at least
// one id that does NOT exist in the slice set AND is NOT a mock stub AND
// has not been dispatched/landed — i.e., a truly dangling dep that will
// never resolve. Cycles are detected separately by DFS and warned to
// stderr; the orchestrator's oa-005 owns richer stuck detection (timeout,
// re-trigger count).
for (const s of slices) {
  if (s.type !== 'AFK' || s.mock === true) continue;
  if (dispatchedOrLandedIds.has(s.id)) continue;
  const deps = s.blocked_by ?? [];
  const dangling = deps.some(dep => !byId.has(dep) && !mockStubIds.has(dep) && !dispatchedOrLandedIds.has(dep));
  if (dangling) stuck.push(s.id);
}

readyEdges.sort();
inFlight.sort();
stuck.sort();

const allRealLanded = realCount > 0 && realLandedCount === realCount;
// auditReady: every real slice is landed AND the audit hasn't been dispatched yet
const auditReady = allRealLanded && mockAuditId !== null
  ? !dispatchedOrLandedIds.has(mockAuditId)
  : false;
// allLanded: every real slice is landed (audit is a separate flag)
// Note: the AC explicitly says "allLanded: true" once all real are landed,
// before the audit fires — allLanded is the "all REAL done" trigger, not
// "the whole pipeline including the audit has finished".
const allLanded = allRealLanded;

const out = {
  readyEdges,
  inFlight,
  stuck,
  allLanded,
  auditReady,
};

process.stdout.write(JSON.stringify(out) + '\n');
// exit 0 unless we want to flag missing-INDEX (we don't — missing INDEX.md is OK)

// ─── helpers
function statSafe(p) { try { return statSync(p); } catch { return null; } }
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
function parseIssue(path, file) {
  const text = readText(path);
  const fm = parseFrontmatter(text);
  return { file, ...fm };
}
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    out[kv[1]] = parseValue(kv[2]);
  }
  return out;
}
function parseValue(v) {
  v = (v ?? '').trim();
  if (v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '[]') return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  return v;
}

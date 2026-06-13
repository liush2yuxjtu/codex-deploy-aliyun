#!/usr/bin/env node
// /office-agents e2e wall-clock summary printer — oa-007.
//
// Reads the JSON summary written by `multi-user-isolation-wallclock.mjs`
// from argv[2], prints the 1-line SC-7 verdict, and exits 0/5
// (PASS/FAIL). Kept separate from the harness so the bash wrapper
// doesn't have to embed multi-line JS in a single-quoted string
// (which is a quoting nightmare on macOS bash 3.2).

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: print-summary.mjs <path-to-summary.json>\n');
  process.exit(2);
}
const raw = readFileSync(path, 'utf8').trim();
let summary;
try {
  summary = JSON.parse(raw);
} catch (e) {
  process.stderr.write('✗ could not parse harness JSON output\n');
  process.stderr.write(raw + '\n');
  process.exit(3);
}
if (!summary.ok) {
  process.stderr.write('✗ harness reported ok=false: ' + (summary.error || '(no error message)') + '\n');
  process.exit(4);
}
const mins = summary.wall_clock_min;
const pct  = summary.pct_of_baseline;
const verdict = summary.verdict;
const fmt = (n) => {
  if (n < 1) return `${Math.round(n * 60)}s`;
  return `${n.toFixed(1)} min`;
};
const audit = summary.audit_verdict;
const real = summary.afk_agents_baseline_min;
console.log(`e2e: ${fmt(mins)} (vs afk-agents ${real} min on the same plan) — ${pct}% of baseline — ${verdict}`);
const p50 = summary.latency_distribution_ms.p50;
const p95 = summary.latency_distribution_ms.p95;
const n   = summary.latency_distribution_ms.n;
const stuck = summary.slices_stuck.length;
console.log(`per-edge dispatch latency: n=${n} p50=${p50}ms p95=${p95}ms (mock agent sleep 1-5s)`);
console.log(`passes: ${summary.passes_run} · dispatched: ${summary.slices_dispatched} · landed: ${summary.slices_landed} · stuck: ${stuck} · audit: ${audit}`);
// Synchronous exit so the buffered stdout flushes before the
// process dies. Without this, the last line can be lost when
// the printer is invoked from a bash wrapper that captures
// stdout via a pipe.
process.exit(verdict === 'PASS' ? 0 : 5);

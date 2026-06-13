#!/usr/bin/env node
// /office-agents mock generator + refiner (oa-003).
//
// Two exported functions, zero npm deps, Node >= 18 ESM.
//
//   generateUpfrontMocks(sliceSet, issuesDir)
//     First-invocation pass: for every slice in `sliceSet` whose frontmatter
//     has `mock: true`, write a typed-contract .md file under `issuesDir`.
//     Idempotent — re-running does NOT overwrite existing files (per the
//     "stub stays one issue per node per wave" rule).
//
//   refineMockBody(issuesDir, realSliceId)
//     Subsequent-invocation pass: when a real slice lands, find any mock .md
//     in `issuesDir` whose frontmatter's `mock_refines` lists `realSliceId`,
//     and edit the mock's body in place — same file path, same frontmatter,
//     only the body becomes a one-line pointer to the real implementation.
//     No-op when no mock lists `realSliceId`.
//
// Determinism: no timestamps, no random IDs, no environment-dependent paths.
// Output bytes for a given (sliceSet, issuesDir, realSliceId) are stable
// across runs.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Write typed-contract .md stubs for every `mock: true` slice in `sliceSet`
 * whose file does NOT already exist in `issuesDir`.
 *
 * @param {Array<Record<string, any>>} sliceSet  Pre-parsed slice objects
 *   (id, title, mock, mock_refines, blocked_by, …). The orchestrator
 *   typically passes the result of parsing every *.md in issuesDir.
 * @param {string} issuesDir  Absolute path to the /to-issues output dir
 *   (the dir that holds INDEX.md + every slice's .md).
 * @returns {{ written: string[], skipped: string[] }}
 *   Lists of stub file paths written vs. skipped (because they already
 *   existed — the "stub stays one issue per node per wave" rule).
 */
export function generateUpfrontMocks(sliceSet, issuesDir) {
  const dir = resolve(issuesDir);
  const written = [];
  const skipped = [];

  if (!statSafe(dir)) {
    throw new Error(`mock-gen: issues dir not found: ${dir}`);
  }
  if (!Array.isArray(sliceSet)) {
    throw new Error(`mock-gen: sliceSet must be an array, got ${typeof sliceSet}`);
  }

  for (const slice of sliceSet) {
    if (!slice || slice.mock !== true) continue;
    if (!slice.id) continue;
    const filePath = join(dir, `${slice.id}.md`);
    if (existsSync(filePath)) {
      skipped.push(filePath);
      continue;
    }
    const body = renderStubBody(slice);
    writeFileSync(filePath, body, 'utf8');
    written.push(filePath);
  }
  return { written, skipped };
}

/**
 * Edit the body (in place) of every mock .md in `issuesDir` whose
 * frontmatter `mock_refines` lists `realSliceId`. Replaces the mock's
 * `## Mock contract surface` section with the one-line pointer per
 * SKILL.md step 7.
 *
 * @param {string} issuesDir  Absolute path to the /to-issues output dir.
 * @param {string} realSliceId  The id of the real slice that just landed.
 * @returns {{ refined: string[], noDependents: boolean }}
 *   `refined` lists mock file paths whose body was rewritten. If no mock
 *   depended on `realSliceId`, returns `{ refined: [], noDependents: true }`.
 */
export function refineMockBody(issuesDir, realSliceId) {
  const dir = resolve(issuesDir);
  const refined = [];

  if (!statSafe(dir)) {
    throw new Error(`mock-gen: issues dir not found: ${dir}`);
  }
  if (typeof realSliceId !== 'string' || realSliceId.length === 0) {
    throw new Error(`mock-gen: realSliceId must be a non-empty string`);
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md').sort();
  for (const f of files) {
    const filePath = join(dir, f);
    const text = readFileSync(filePath, 'utf8');
    const fm = parseFrontmatter(text);
    if (fm.mock !== true) continue;
    if (!Array.isArray(fm.mock_refines)) continue;
    if (!fm.mock_refines.includes(realSliceId)) continue;
    const newBody = renderRefinedBody(realSliceId);
    const newText = replaceMockContractSurface(text, newBody);
    writeFileSync(filePath, newText, 'utf8');
    refined.push(filePath);
  }
  return { refined, noDependents: refined.length === 0 };
}

// ─── body renderers ────────────────────────────────────────────────────────

/**
 * Render the typed-contract stub body for a mock slice. The body shape
 * mirrors the `oa-mock-001..004` pattern: frontmatter + heading + Mock
 * contract surface section + Wave 1 stub header + Wave N refinement
 * placeholder + Acceptance criteria.
 *
 * Determinism: no timestamps. The "Wave N refinement" placeholder names
 * the waves that `mock_refines` lists, in stable sorted order.
 */
function renderStubBody(slice) {
  const fm = renderFrontmatter(slice);
  const refines = Array.isArray(slice.mock_refines)
    ? [...slice.mock_refines].sort()
    : [];
  const title = slice.title || slice.id;
  const mockContractSurface = renderMockContractSurface(slice);
  const refinementLines = refines.length === 0
    ? '_No `mock_refines` declared — body will not be auto-refined by the orchestrator._'
    : refines.map(r => `- \`<${r}>\` lands → orchestrator replaces the body with the one-line pointer per SKILL.md step 7.`)
              .join('\n');
  const acLines = [
    `- [ ] File checked in at round 1 with the typed contract (this file).`,
    `- [ ] At round 2, the file is edited in place to reference the real implementation.`,
    `- [ ] \`mock_refines\` is the only frontmatter change at round 2.`,
    `- [ ] oa-006 (the audit) confirms no residual stub markers in the real implementation.`,
  ].join('\n');

  return `${fm}
# ${slice.id}: ${title} (typed contract stub)

## Mock contract surface

This file is a typed-contract stub for the slice that lands at \`<real-id>\`.
Workers reading this file in round 1 can write code against the contract
without waiting for the real implementation.

${mockContractSurface}

## Wave 1 behavior

Pure-typed stub. Body documents the contract surface that the real slice
will satisfy. No real implementation; no worker is dispatched against
this file (the orchestrator filters \`mock: true\` slices out of the
ready-edge set per SKILL.md step 5).

## Wave N refinement

When the real implementation lands (the slices that \`mock_refines\` lists),
the orchestrator edits this file's body in place to:

\`\`\`
This mock is realized by \`<real-id>\`. See that slice for the real implementation.
\`\`\`

Per refinement:
${refinementLines}

## Acceptance criteria

${acLines}
`;
}

/**
 * Render the `## Mock contract surface` body for a mock slice. Pulls the
 * `## What to build` block out of the originating slice's .md file if it
 * exists (so the contract surface mirrors the slice's spec verbatim),
 * otherwise emits a generic placeholder pointing back at the slice.
 *
 * The shape is deterministic: same slice → same output bytes, regardless
 * of when / where the script runs.
 */
function renderMockContractSurface(slice) {
  // We cannot reliably re-read the slice's .md here (sliceSet is the
  // orchestrator's already-parsed view). So the contract surface is the
  // slice's own fields, rendered as a typed-contract skeleton.
  const blockedBy = Array.isArray(slice.blocked_by) ? [...slice.blocked_by].sort() : [];
  const refines = Array.isArray(slice.mock_refines) ? [...slice.mock_refines].sort() : [];
  const idLine = `- **slice id**: \`${slice.id}\``;
  const titleLine = `- **title**: ${slice.title || '(unset)'}`;
  const refinesLine = refines.length === 0
    ? `- **mock_refines**: _(unset — body will not be auto-refined)_`
    : `- **mock_refines**: ${refines.map(r => `\`${r}\``).join(', ')}`;
  const blockedByLine = blockedBy.length === 0
    ? `- **blocked_by**: _(none — stub is available from round 1)_`
    : `- **blocked_by**: ${blockedBy.map(b => `\`${b}\``).join(', ')}`;
  return [
    idLine,
    titleLine,
    refinesLine,
    blockedByLine,
    '',
    '_The real implementation is documented in the slice whose id is listed in `mock_refines`. This stub stands in until that real lands._',
  ].join('\n');
}

/**
 * Render the in-place refinement body for a mock whose upstream real
 * just landed. Per SKILL.md step 7:
 *
 *   This mock is realized by `<real-id>`. See that slice for the real implementation.
 */
function renderRefinedBody(realSliceId) {
  return `This mock is realized by \`${realSliceId}\`. See that slice for the real implementation.`;
}

/**
 * Replace the contents of the `## Mock contract surface` section in
 * `text` with `newBody`, leaving everything else (frontmatter, headings,
 * other sections) byte-identical.
 *
 * The section runs from the `## Mock contract surface` heading line to
 * the next `^## ` heading (or end of file). We rewrite everything between
 * the heading line and the next heading (or EOF) to `newBody`.
 */
function replaceMockContractSurface(text, newBody) {
  const headingRe = /^## Mock contract surface\s*$/m;
  const nextHeadingRe = /^## /m;
  const headingMatch = text.match(headingRe);
  if (!headingMatch) {
    // No `## Mock contract surface` section — nothing to refine. Return
    // text unchanged so refineMockBody is a no-op for malformed mocks.
    return text;
  }
  const headingStart = headingMatch.index;
  const afterHeading = headingStart + headingMatch[0].length;
  // Find the next `## ` heading at column 0 after `afterHeading`.
  const tail = text.slice(afterHeading);
  const tailMatch = tail.match(nextHeadingRe);
  const sectionEnd = tailMatch ? afterHeading + tailMatch.index : text.length;
  const before = text.slice(0, afterHeading);
  const after = text.slice(sectionEnd);
  return `${before}\n\n${newBody}\n\n${after.replace(/^\n+/, '\n')}`;
}

// ─── frontmatter ───────────────────────────────────────────────────────────

/**
 * Render the YAML frontmatter for a stub file. Stable key order, no
 * timestamps, no environment-dependent values.
 *
 * The shape matches the slice set's frontmatter schema (id / title /
 * round / type / mock / mock_refines / blocked_by / triage / status /
 * parallel_group). Unknown / absent fields are omitted so the stub
 * frontmatter is the minimum needed for the orchestrator to find and
 * refine it later.
 */
function renderFrontmatter(slice) {
  const lines = ['---'];
  lines.push(`id: ${yamlScalar(slice.id)}`);
  lines.push(`title: ${yamlScalar(slice.title || slice.id)}`);
  if (slice.round !== undefined && slice.round !== null) {
    lines.push(`round: ${yamlScalar(slice.round)}`);
  }
  if (slice.type) {
    lines.push(`type: ${yamlScalar(slice.type)}`);
  }
  lines.push(`mock: true`);
  if (Array.isArray(slice.mock_refines) && slice.mock_refines.length > 0) {
    lines.push(`mock_refines:`);
    for (const r of [...slice.mock_refines].sort()) {
      lines.push(`  - ${yamlScalar(r)}`);
    }
  }
  if (Array.isArray(slice.blocked_by) && slice.blocked_by.length > 0) {
    lines.push(`blocked_by:`);
    for (const b of [...slice.blocked_by].sort()) {
      lines.push(`  - ${yamlScalar(b)}`);
    }
  }
  if (slice.parallel_group) {
    lines.push(`parallel_group: ${yamlScalar(slice.parallel_group)}`);
  }
  lines.push(`triage: ready-for-agent`);
  lines.push(`status: pending`);
  lines.push(`---`);
  return lines.join('\n');
}

/**
 * Quote a YAML scalar if it contains characters that would otherwise
 * need escaping (colons, leading/trailing whitespace, etc.). Stable
 * across runs (no smart-quote detection, no env-dependent behavior).
 */
function yamlScalar(v) {
  const s = String(v);
  if (s === '') return '""';
  if (/[:#&*!|>'"%@`{}\[\],\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ─── frontmatter parser (mirror of to-issues/build.mjs) ────────────────────

/**
 * Parse a YAML-ish frontmatter block from a `.md` text. Handles the
 * subset that the office-agents slice schema needs:
 *   - scalar `key: value` lines
 *   - `key:` followed by indented `- item` list items
 *
 * Intentionally NOT a full YAML parser. Mirrors the parser in
 * /to-issues/scripts/build.mjs so behavior is consistent across the
 * office-agents pipeline.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const body = m[1];
  const out = {};
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = (kv[2] ?? '').trim();
    if (rest === '') {
      // Look ahead for indented list items.
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const itemLine = lines[j];
        const itemMatch = itemLine.match(/^\s+-\s+(.*)$/);
        if (!itemMatch) break;
        items.push(unquoteYamlScalar(itemMatch[1].trim()));
        j++;
      }
      out[key] = items;
      i = j;
      continue;
    }
    out[key] = unquoteYamlScalar(rest);
    i++;
  }
  return out;
}

function unquoteYamlScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '[]') return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => unquoteYamlScalar(s.trim())).filter(x => x !== '');
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

// ─── tiny fs helpers (mirror to-issues/build.mjs pattern) ──────────────────

function statSafe(p) { try { return statSync(p); } catch { return null; } }

// ─── CLI entry (for ad-hoc debugging; tests import the functions) ──────────

// Detect "called as `node mock-gen.mjs ...`" vs "imported by another script".
// `import.meta.url` is the URL of THIS module; `process.argv[1]` is the path
// of the entry script. They match only when this file is the entry.
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === resolve(basename(import.meta.url))) {
  const args = process.argv.slice(2);
  const issuesDir = resolve(args[0] ?? './.agent/issues');
  const action = args[1] ?? 'generate';
  const sliceSet = readSliceSet(issuesDir);
  if (action === 'generate') {
    const out = generateUpfrontMocks(sliceSet, issuesDir);
    console.log(JSON.stringify(out, null, 2));
  } else if (action === 'refine') {
    const realSliceId = args[2];
    if (!realSliceId) { console.error('usage: refine <issues-dir> refine <real-slice-id>'); process.exit(2); }
    const out = refineMockBody(issuesDir, realSliceId);
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error(`unknown action: ${action}`);
    process.exit(2);
  }
}

/**
 * CLI helper: parse every slice .md in `issuesDir` into a sliceSet.
 * Mirrors the same parse as /to-issues/scripts/build.mjs.
 */
function readSliceSet(issuesDir) {
  const files = readdirSync(issuesDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md').sort();
  return files.map(f => {
    const text = readFileSync(join(issuesDir, f), 'utf8');
    return { file: f, ...parseFrontmatter(text) };
  });
}

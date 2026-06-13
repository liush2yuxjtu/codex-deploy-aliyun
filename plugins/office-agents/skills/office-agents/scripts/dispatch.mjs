// dispatch.mjs — per-edge dispatcher + worker prompt builder for /office-agents.
//
// Two exported functions:
//   - buildWorkerPrompt(slicePath): reads the slice's .md file, extracts
//     the "## What to build" + "## Acceptance criteria" sections, and
//     returns the full worker prompt string. The prompt body is
//     byte-identical to the /afk-agents worker template except for the
//     office-agents-specific preamble paragraph (AP-4).
//   - dispatchEdge({ sliceId, slicePath, issuesDir, stateLogPath, dispatchFn }):
//     calls buildWorkerPrompt(slicePath), then dispatchFn({ prompt, ... })
//     (the Agent tool in production; a mock in tests), then appends a
//     "dispatched" JSONL line to the state log. Returns the dispatch result.
//
// Zero-dep Node ESM (Node >= 18).

import { readFile, appendFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------
//
// The /afk-agents worker template (from ~/.claude/skills/afk-agents/SKILL.md
// §"Wave dispatch shape — concrete example") is the byte-identical baseline.
// Per AP-4, the office-agents prompt differs from it by a single-paragraph
// preamble insertion only. Anything else is a bug.
//
// We keep this constant LITERAL so the only diff vs /afk-agents is the
// one-place insertion below. Don't add office-agents-specific advice to
// the body — if a new rule is needed, edit /afk-agents' template first and
// mirror the change here.
const AFK_AGENTS_PROMPT_TEMPLATE = `You are implementing ONE slice from a /to-issues breakdown. The slice:

  - id: <SLICE_ID>
  - title: <SLICE_TITLE>
  - file: <SLICE_FILE>     # full path to the .md
  - upstreams realized: <SLICE_BLOCKED_BY>   # these are already done

The full slice body is at <SLICE_FILE> — read it, follow its "What to build" + "Acceptance criteria".

Hard rules (mirrored from /afk-agents — do NOT deviate):
- Do NOT spawn further subagents. You are the worker. The Agent tool is off-limits.
- Do NOT ask the user questions. If a real ambiguity hits, make a defensible default and add it as a bullet under a \`## Ambiguities resolved\` section in your implementation report.
- Do NOT modify the slice's frontmatter (\`triage: in-progress\` stays — the orchestrator owns frontmatter transitions).
- Do NOT touch any \`mock:*.md\` file.
- Do NOT touch files outside your slice's scope (<SLICE_FILES_SCOPE> for the new files; <SLICE_FILE> for AC flips + impl report).
- On a 429 / token-plan / quota error: retry silently once. If the retry also 429s, stop and return a status line. Do NOT ask the user.
- AP-4: the prompt body must be byte-identical to the /afk-agents worker template except for the office-agents-specific preamble paragraph. Diff vs the /afk-agents template should be a single-paragraph insertion.

You MAY:
- Mark acceptance criteria \`[x]\` as you complete them.
- Add a \`## Implementation Report\` section at the end of the slice file with: files touched, commit hashes, deploy (if any), AC skipped (with reason), ambiguities resolved, follow-ups.
- Create new files under <SLICE_FILES_SCOPE>.

When done, return a 2-3 line summary: what you built, commit hashes, anything punted.
`;

// The office-agents-specific preamble paragraph. Inserted as a single
// paragraph at the top of the prompt. This is the ONLY diff vs the
// /afk-agents template (per AP-4). If you need to add another
// office-agents-only directive, put it here — never in the body.
const OFFICE_AGENTS_PREAMBLE = `You are dispatched via the office-agents event-driven dispatcher. Your slice is ready because all upstream deps have landed. State log entry on dispatch: \`<edge>: dispatched via office-agents\`.

`;

// ---------------------------------------------------------------------------
// Frontmatter parsing (only the bits dispatch needs)
// ---------------------------------------------------------------------------
//
// We don't need the full 10-field frontmatter parser — `ready-edge.mjs`
// already owns that seam. Dispatch only needs id / title / blocked_by /
// files. Keep it tiny, zero-dep.

function parseFrontmatter(markdown) {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { frontmatter: {}, body: markdown };
  }
  const fmText = fmMatch[1];
  const body = markdown.slice(fmMatch[0].length);

  const frontmatter = {};
  const lines = fmText.split('\n');
  let currentListKey = null;
  for (const line of lines) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentListKey) {
      const v = listItem[1].trim().replace(/^['"]|['"]$/g, '');
      if (!Array.isArray(frontmatter[currentListKey])) {
        frontmatter[currentListKey] = [];
      }
      frontmatter[currentListKey].push(v);
      continue;
    }
    currentListKey = null;
    const kv = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const raw = kv[2].trim();
      if (raw === '') {
        currentListKey = key;
        frontmatter[key] = [];
      } else if (raw === 'true') {
        frontmatter[key] = true;
      } else if (raw === 'false') {
        frontmatter[key] = false;
      } else {
        frontmatter[key] = raw.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return { frontmatter, body };
}

// Extract the "## What to build" and "## Acceptance criteria" sections
// from the slice body. Returns the raw markdown text of both sections
// (each with its `## ` heading reattached), joined by a blank line.
//
// The body of each `## Heading` block is everything from the heading
// down to (but not including) the next `## ` line or end-of-body. We
// match with a negative lookahead — `(?!^##\s)` — anchored at every
// newline so the matcher advances line-by-line until it hits a `## `
// boundary or EOF.
function extractWorkerSections(body) {
  const out = [];
  const re = /^## (.+?)\n((?:[^\n]|\n(?!##\s))+)/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const heading = m[1].trim();
    const content = m[2].trimEnd();
    if (/^What to build$/i.test(heading)) {
      out.push(`## ${heading}\n\n${content}`);
    } else if (/^Acceptance criteria$/i.test(heading)) {
      out.push(`## ${heading}\n\n${content}`);
    }
  }
  return out.join('\n\n');
}

// Resolve the "files scope" string — the directory where the worker
// should place new files. Pulled from `files:` frontmatter; falls back
// to the slice file's parent directory.
function resolveFilesScope(frontmatter, slicePath) {
  if (Array.isArray(frontmatter.files) && frontmatter.files.length > 0) {
    const firstFile = frontmatter.files[0];
    const lastSlash = firstFile.lastIndexOf('/');
    return lastSlash >= 0 ? firstFile.slice(0, lastSlash) : firstFile;
  }
  const lastSlash = slicePath.lastIndexOf('/');
  return lastSlash >= 0 ? slicePath.slice(0, lastSlash) : '.';
}

// ---------------------------------------------------------------------------
// buildWorkerPrompt
// ---------------------------------------------------------------------------

// Read the slice file and return the full worker prompt string. Pure
// (modulo the file read); no other I/O. Throws on missing frontmatter
// id/title or missing body sections.
export async function buildWorkerPrompt(slicePath) {
  const md = await readFile(slicePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(md);

  if (!frontmatter.id || !frontmatter.title) {
    throw new Error(
      `dispatch: slice ${slicePath} is missing required frontmatter ` +
        `(id / title). Found: ${JSON.stringify(Object.keys(frontmatter))}`,
    );
  }

  const blockedBy = Array.isArray(frontmatter.blocked_by)
    ? frontmatter.blocked_by
    : [];
  const blockedByStr = blockedBy.length === 0 ? '(none)' : blockedBy.join(', ');

  const filesScope = resolveFilesScope(frontmatter, slicePath);

  const sections = extractWorkerSections(body);
  if (!sections) {
    throw new Error(
      `dispatch: slice ${slicePath} is missing required body sections ` +
        `("## What to build" + "## Acceptance criteria").`,
    );
  }

  // Substitute placeholders. <SLICE_FILE> appears twice in the template
  // — use replaceAll.
  const substituted = AFK_AGENTS_PROMPT_TEMPLATE
    .replace('<SLICE_ID>', frontmatter.id)
    .replace('<SLICE_TITLE>', frontmatter.title)
    .replaceAll('<SLICE_FILE>', slicePath)
    .replace('<SLICE_BLOCKED_BY>', blockedByStr)
    .replaceAll('<SLICE_FILES_SCOPE>', filesScope);

  // AP-4: the ONLY diff vs /afk-agents is the preamble insertion. We
  // prepend it as a single paragraph at the very top of the prompt.
  const prompt = OFFICE_AGENTS_PREAMBLE + substituted;

  // Append the slice's own "## What to build" + "## Acceptance criteria"
  // verbatim so the worker has the body inline (the file-read is still
  // the canonical source, but the inline copy guarantees the agent sees
  // the same text without depending on file-read behavior in tests).
  return `${prompt}---\n\n# Slice body (extracted from ${slicePath})\n\n${sections}\n`;
}

// ---------------------------------------------------------------------------
// dispatchEdge
// ---------------------------------------------------------------------------

// Append a JSONL line to the state log. Single-writer orchestrator means
// plain append is safe — no need for lock/rename tricks.
async function appendJsonl(stateLogPath, obj) {
  await appendFile(stateLogPath, JSON.stringify(obj) + '\n', 'utf8');
}

// dispatchEdge: build the prompt, call dispatchFn, append the state-log line.
//
// Contract:
//   dispatchFn({ prompt, sliceId, slicePath }) -> { agentId: string, ... }
//
// Returns the dispatch result augmented with the `stateLogLine` that was
// just appended, so the orchestrator can echo the event to stdout.
export async function dispatchEdge({
  sliceId,
  slicePath,
  issuesDir: _issuesDir, // reserved; signature mirrors oa-005's call shape
  stateLogPath,
  dispatchFn,
}) {
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new Error('dispatch: sliceId is required');
  }
  if (typeof slicePath !== 'string' || slicePath.length === 0) {
    throw new Error('dispatch: slicePath is required');
  }
  if (typeof stateLogPath !== 'string' || stateLogPath.length === 0) {
    throw new Error('dispatch: stateLogPath is required');
  }
  if (typeof dispatchFn !== 'function') {
    throw new Error('dispatch: dispatchFn must be a function');
  }

  const prompt = await buildWorkerPrompt(slicePath);
  const result = await dispatchFn({ prompt, sliceId, slicePath });

  const agentId =
    result && typeof result.agentId === 'string' && result.agentId.length > 0
      ? result.agentId
      : 'unknown';

  // Snapshot the deps at dispatch time so the state log is the join point
  // for causality reasoning on subsequent invocations.
  const md = await readFile(slicePath, 'utf8');
  const { frontmatter } = parseFrontmatter(md);
  const depsAtDispatch = Array.isArray(frontmatter.blocked_by)
    ? frontmatter.blocked_by.slice()
    : [];

  const logLine = {
    ts: new Date().toISOString(),
    dispatcher: 'office',
    edge: sliceId,
    slice_path: slicePath,
    deps_at_dispatch: depsAtDispatch,
    agent_id: agentId,
    status: 'dispatched',
  };

  await appendJsonl(stateLogPath, logLine);

  return { ...(result || {}), stateLogLine: logLine };
}

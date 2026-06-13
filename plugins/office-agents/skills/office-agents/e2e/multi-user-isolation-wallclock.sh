#!/usr/bin/env bash
# /office-agents e2e wall-clock runner — oa-007.
#
# Drives the e2e harness against the multi-user-isolation wave plan
# (`docs/issues/multi-user-isolation/`) using a hermetic `dispatchFn`
# mock — no real LLM cost, no live `codex exec`, no network. Verifies
# the SC-7 gold metric: total wall-clock ≤ 60% of the published
# /afk-agents baseline (40 min → 24 min).
#
# Usage:
#   bash plugins/office-agents/skills/office-agents/e2e/multi-user-isolation-wallclock.sh
#   bash plugins/office-agents/skills/office-agents/e2e/multi-user-isolation-wallclock.sh -- --max-passes 30
#
# Flags after `--` OVERRIDE the defaults listed below. The wrapper
# puts the override flags BEFORE the defaults so the harness's
# `arg(name, fallback)` lookup (first occurrence wins) picks them up.

set -euo pipefail

# ─── resolve paths ──────────────────────────────────────────────────────
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${THIS_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PLUGIN_DIR}/../../../.." && pwd)"
HARNESS="${THIS_DIR}/multi-user-isolation-wallclock.mjs"
PRINTER="${THIS_DIR}/print-summary.mjs"
FIXTURE="${REPO_ROOT}/docs/issues/multi-user-isolation"

# ─── prerequisites ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not on PATH — install Node >= 18" >&2
  exit 2
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "✗ node >= 18 required (found $(node --version))" >&2
  exit 2
fi
if [ ! -d "${FIXTURE}" ]; then
  echo "✗ fixture dir not found: ${FIXTURE}" >&2
  exit 2
fi
if [ ! -f "${HARNESS}" ]; then
  echo "✗ harness not found: ${HARNESS}" >&2
  exit 2
fi
if [ ! -f "${PRINTER}" ]; then
  echo "✗ printer not found: ${PRINTER}" >&2
  exit 2
fi

# ─── args ──────────────────────────────────────────────────────────────
# Anything after `--` OVERRIDES the defaults. We splice them BEFORE
# the defaults so the harness's `arg()` (first-occurrence-wins) picks
# up the override.
DEFAULT_ARGS=(
  --retrigger-ms 30000
  --worker-min-ms 1000
  --worker-max-ms 5000
  --baseline-min 40
  --max-passes 60
  --no-progress-limit 5
)
USER_ARGS=()
if [ "${1:-}" = "--" ]; then
  shift
  USER_ARGS=("$@")
fi

# ─── run ───────────────────────────────────────────────────────────────
TMP_JSON="$(mktemp -t oa-007-e2e.XXXXXX.json)"
trap 'rm -f "${TMP_JSON}"' EXIT

set +e
# The harness writes PURE JSON to stdout and the orchestrator's
# streaming pass lines to stderr. Capture stdout → TMP_JSON for
# the print-summary.mjs; let stderr stream to the terminal so
# the user sees the pass lines in real time.
if [ "${#USER_ARGS[@]}" -gt 0 ]; then
  node "${HARNESS}" \
    --fixture "${FIXTURE}" \
    "${USER_ARGS[@]}" \
    "${DEFAULT_ARGS[@]}" \
    >"${TMP_JSON}"
else
  node "${HARNESS}" \
    --fixture "${FIXTURE}" \
    "${DEFAULT_ARGS[@]}" \
    >"${TMP_JSON}"
fi
NODE_RC=$?
set -e

# Echo the raw JSON summary (useful for CI / dashboards).
cat "${TMP_JSON}"

if [ "${NODE_RC}" -ne 0 ]; then
  echo "✗ e2e harness crashed (node exit ${NODE_RC})" >&2
  exit "${NODE_RC}"
fi

# ─── print 1-line summary ──────────────────────────────────────────────
node "${PRINTER}" "${TMP_JSON}"

#!/usr/bin/env bash
# dev-down.sh — stop the worktree-local dev server.
# Reads .worktree.pid, sanity-checks the command line to avoid killing an
# unrelated process that happened to inherit our pidfile, then SIGTERM,
# then SIGKILL after a grace period.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$WORKTREE_ROOT/.worktree.pid"

GRACE_SECONDS="${GRACE_SECONDS:-5}"
EXPECTED_CMD_PATTERN="${EXPECTED_CMD_PATTERN:-node server/server.js}"

# --- pidfile present? ---
if [ ! -f "$PIDFILE" ]; then
  echo "[dev-down] no pidfile at $PIDFILE — nothing to stop." >&2
  exit 0
fi

PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -z "${PID:-}" ]; then
  echo "[dev-down] empty pidfile; removing." >&2
  rm -f "$PIDFILE"
  exit 0
fi

# --- process exists? ---
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[dev-down] pid $PID is not running; removing stale pidfile." >&2
  rm -f "$PIDFILE"
  exit 0
fi

# --- sanity: command line must match our server ---
CMD=$(ps -p "$PID" -o args= 2>/dev/null || true)
if ! echo "$CMD" | grep -q "$EXPECTED_CMD_PATTERN"; then
  echo "[dev-down] pid $PID is not '$EXPECTED_CMD_PATTERN' (args: '$CMD'). refusing to kill." >&2
  echo "[dev-down] if this pidfile is stale, remove it manually: rm $PIDFILE" >&2
  exit 1
fi

echo "[dev-down] stopping pid=$PID (args: $CMD)"

# --- SIGTERM, wait, SIGKILL ---
kill -TERM "$PID" 2>/dev/null || true

WAITED=0
while kill -0 "$PID" 2>/dev/null; do
  if [ "$WAITED" -ge "$GRACE_SECONDS" ]; then
    echo "[dev-down] pid $PID did not exit in ${GRACE_SECONDS}s; sending SIGKILL." >&2
    kill -KILL "$PID" 2>/dev/null || true
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

# --- final verification ---
if kill -0 "$PID" 2>/dev/null; then
  echo "[dev-down] pid $PID still alive after SIGKILL; manual cleanup required." >&2
  exit 2
fi

rm -f "$PIDFILE"
echo "[dev-down] stopped. pidfile removed."

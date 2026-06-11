#!/usr/bin/env bash
# dev-up.sh — start the project's dev stack on a per-worktree port.
# Derives port = 3030 + FNV-1a(worktreePath) % 1000, so multiple git worktrees
# of this repo can run side-by-side without colliding on 3030.
# Writes the server PID to .worktree.pid; dev-down.sh reads it back.
set -euo pipefail

# --- locate worktree root (the dir holding this script's parent) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE_PATH="${WORKTREE_ROOT}"

PIDFILE="$WORKTREE_ROOT/.worktree.pid"
LOGFILE="$WORKTREE_ROOT/.worktree.log"
BASE_PORT=3030
OFFSET_RANGE=1000

# --- FNV-1a 32-bit hash of a string (worktree path) ---
# Pure awk impl. Avoids any new system deps (no python, no md5sum).
# 256-byte lookup table for byte→index conversion. Avoids passing
# control bytes through the shell, which is fragile.
fnv1a_portable() {
  local s="$1"
  # Use xxd if available, fall back to od, to hex-encode bytes deterministically.
  local hex
  if command -v xxd >/dev/null 2>&1; then
    hex=$(printf '%s' "$s" | xxd -p -c 99999)
  else
    hex=$(printf '%s' "$s" | od -An -vtx1 | tr -d ' \n')
  fi
  awk -v hex="$hex" 'BEGIN{
    h = 2166136261
    for (i = 1; i <= length(hex); i += 2) {
      pair = substr(hex, i, 2)
      # Convert hex pair to decimal (0..255)
      o = 0
      for (j = 1; j <= 2; j++) {
        c = substr(pair, j, 1)
        v = index("0123456789abcdef", tolower(c)) - 1
        if (v < 0) v = 0
        o = o * 16 + v
      }
      h = (h * 16777619) % 4294967296
      h = (h + o) % 4294967296
    }
    print h
  }'
}

# --- derive port offset ---
HASH=$(fnv1a_portable "$WORKTREE_PATH")
OFFSET=$(( HASH % OFFSET_RANGE ))
PORT=$(( BASE_PORT + OFFSET ))

echo "[dev-up] worktree : $WORKTREE_PATH"
echo "[dev-up] hash     : $HASH"
echo "[dev-up] offset   : $OFFSET"
echo "[dev-up] port     : $PORT"

# --- already-running check (re-check pidfile, not just trust it) ---
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    # Sanity: is it actually our server?
    if ps -p "$OLD_PID" -o args= 2>/dev/null | grep -q "node server/server.js"; then
      echo "[dev-up] already running, pid=$OLD_PID (port $PORT). use scripts/dev-down.sh first." >&2
      exit 1
    fi
  fi
  # Stale pidfile: process gone or not ours.
  rm -f "$PIDFILE"
fi

# --- port collision check ---
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev-up] port $PORT already in use (lsof)." >&2
    echo "[dev-up] hint: another process (e.g. sub3api on 3000 family) is on this port. re-hash by renaming the worktree." >&2
    exit 2
  fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "[dev-up] port $PORT already in use (nc)." >&2
    exit 2
  fi
fi

# --- launch server in background ---
cd "$WORKTREE_ROOT"
: > "$LOGFILE"
PORT="$PORT" nohup node server/server.js >>"$LOGFILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# --- verify it actually came up ---
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[dev-up] server died on startup. tail of $LOGFILE:" >&2
  tail -n 30 "$LOGFILE" >&2 || true
  rm -f "$PIDFILE"
  exit 3
fi

echo "[dev-up] started  : pid=$SERVER_PID"
echo "[dev-up] log      : $LOGFILE"
echo "[dev-up] pidfile  : $PIDFILE"
echo "[dev-up] try      : curl -sS http://127.0.0.1:$PORT/healthz"

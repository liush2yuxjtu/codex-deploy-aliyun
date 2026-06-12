#!/usr/bin/env bash
# rds-migrate.sh — idempotent applier for migrations/*.sql against the
# codex-deploy-aliyun RDS instance.  Backed by a `_migrations` ledger
# table; running it twice is a no-op.
#
# Usage:
#   scripts/rds-migrate.sh                # apply all pending
#   scripts/rds-migrate.sh --status       # show applied vs pending
#   scripts/rds-migrate.sh --dry-run      # print what would run
#   scripts/rds-migrate.sh --target NNN   # stop after NNN
#   scripts/rds-migrate.sh --ssh          # run against the SWAS-hosted
#                                         # RDS via the SSH key (the only
#                                         # path that works for the
#                                         # cn-hangzhou free-trial RDS
#                                         # we currently expose).
#
# Why this script exists: 010 (codex_jobs) + 014 (codex_runs session id)
# migrations are .sql files, but until now we hand-SSH'd and ran them
# with psql. This wraps the loop in one command, records what's applied,
# and refuses to re-apply a file that's already in the ledger.
#
# v3 #1: rds migrate helper — see docs/issues/021-rds-migrate.md

set -euo pipefail

# ─── creds ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/aliyun-start}"
if [[ -f "$SKILL_DIR/.env" ]]; then
  set -a; . "$SKILL_DIR/.env"; set +a
fi
: "${RDS_HOST:?RDS_HOST not set (source $SKILL_DIR/.env or export it)}"
: "${RDS_PORT:=5432}"
: "${RDS_DB:?RDS_DB not set}"
: "${RDS_USER:?RDS_USER not set}"
: "${RDS_PASSWORD:?RDS_PASSWORD not set}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/aliyun_deploy}"
SERVER_IP="${SERVER_IP:-106.14.154.23}"
MIGRATIONS_DIR="$REPO_DIR/migrations"

# ─── args ──────────────────────────────────────────────────────────────
STATUS_ONLY=0
DRY_RUN=0
USE_SSH=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)    STATUS_ONLY=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --ssh)       USE_SSH=1; shift ;;
    --target)    TARGET="$2"; shift 2 ;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0 ;;
    *)           echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── psql invocation: local or via SSH ────────────────────────────────
psql_run() {
  if [[ "$USE_SSH" -eq 1 ]]; then
    # Pipe the SQL through ssh into the remote psql. Bash-quoting a
    # SQL string with embedded single quotes inside an ssh "cmd" arg
    # is a quoting nightmare; piping sidesteps it entirely.
    echo "$1" | ssh -i "$SSH_KEY" "root@$SERVER_IP" PGPASSWORD="$RDS_PASSWORD" psql \
      -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" \
      -v ON_ERROR_STOP=1 -A -t
  else
    PGPASSWORD="$RDS_PASSWORD" psql \
      -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" \
      -v ON_ERROR_STOP=1 -A -t -c "$1"
  fi
}
psql_run_file() {
  if [[ "$USE_SSH" -eq 1 ]]; then
    # Stream the local file over ssh; remote psql reads it from stdin.
    # Using -f with a local path would fail because the path doesn't
    # exist on the SWAS host.
    cat "$1" | ssh -i "$SSH_KEY" "root@$SERVER_IP" PGPASSWORD="$RDS_PASSWORD" psql \
      -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" \
      -v ON_ERROR_STOP=1 -A -t
  else
    PGPASSWORD="$RDS_PASSWORD" psql \
      -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" \
      -v ON_ERROR_STOP=1 -f "$1"
  fi
}

# ─── ledger ────────────────────────────────────────────────────────────
ensure_ledger() {
  psql_run "CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    md5         TEXT NOT NULL
  );" >/dev/null
}
applied_names() {
  psql_run "SELECT name FROM _migrations ORDER BY name;"
}
md5_of_file() {
  if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | awk '{print $1}'; fi
}

# ─── list pending ──────────────────────────────────────────────────────
list_pending() {
  local applied
  applied="$(applied_names || true)"
  local n=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    [[ -f "$f" ]] || continue
    local base
    base="$(basename "$f")"
    if grep -qxF "$base" <<< "$applied"; then
      continue
    fi
    echo "$base"
    n=$((n+1))
    [[ -n "$TARGET" && "$base" == "$TARGET" ]] && break
  done
  return 0
}

# ─── status mode ──────────────────────────────────────────────────────
if [[ "$STATUS_ONLY" -eq 1 ]]; then
  ensure_ledger
  echo "Applied:"
  applied_names | sed 's/^/  /'
  echo "Pending:"
  list_pending | sed 's/^/  /'
  exit 0
fi

# ─── apply mode ────────────────────────────────────────────────────────
ensure_ledger
pending="$(list_pending || true)"
if [[ -z "$pending" ]]; then
  echo "[rds-migrate] nothing to do (ledger up to date)"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[rds-migrate] DRY RUN — would apply:"
  echo "$pending" | sed 's/^/  /'
  exit 0
fi

echo "[rds-migrate] applying $(echo "$pending" | wc -l | tr -d ' ') migration(s):"
echo "$pending" | sed 's/^/  /'

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  path="$MIGRATIONS_DIR/$name"
  md5="$(md5_of_file "$path")"
  echo "  → $name (md5=$md5)"
  psql_run_file "$path"
  psql_run "INSERT INTO _migrations(name, md5) VALUES ('$name', '$md5');" >/dev/null
done <<< "$pending"

echo "[rds-migrate] done"

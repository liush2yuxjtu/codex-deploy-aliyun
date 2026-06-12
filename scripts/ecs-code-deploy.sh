#!/usr/bin/env bash
# ecs-code-deploy.sh — idempotent atomic deploy for the codex-api service
# on the SWAS host. Replaces the manual scp+systemctl dance we ran during
# the v2 e2e sweep.
#
# Usage:
#   scripts/ecs-code-deploy.sh                       # full deploy
#   scripts/ecs-code-deploy.sh --server-only         # skip migrations
#   scripts/ecs-code-deploy.sh --migrations-only     # skip code drop
#   scripts/ecs-code-deploy.sh --dry-run             # show what would happen
#   scripts/ecs-code-deploy.sh --rollback            # restore last .bak
#
# What it does, in order (each step is checkable, any step fails → abort + rollback):
#   1. Validate: server.js syntax (node -c) + migrations dir present
#   2. Sanity: ssh to SWAS, check current service is running
#   3. Backup: copy existing /opt/codex-api/server.js → .bak.<ts>
#   4. Drop:   scp local server.js + migrations/*.sql to SWAS
#   5. Migrate: ssh into SWAS, run scripts/rds-migrate.sh --ssh
#   6. Restart: systemctl restart codex-api.service
#   7. Verify: curl http://127.0.0.1:3030/healthz (expect ok=true, db.ok=true)
#   8. Log:    append a line to /opt/codex-api/deploy.log
#
# v3 #5: ecs-code-deploy — see docs/issues/025-ecs-code-deploy.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/aliyun_deploy}"
SERVER_IP="${SERVER_IP:-106.14.154.23}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_DIR="${SERVER_DIR:-/opt/codex-api}"
HEALTH_URL="http://127.0.0.1:3030/healthz"

SERVER_ONLY=0
MIGRATIONS_ONLY=0
DRY_RUN=0
ROLLBACK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-only)     SERVER_ONLY=1; shift ;;
    --migrations-only) MIGRATIONS_ONLY=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --rollback)        ROLLBACK=1; shift ;;
    -h|--help)         sed -n '2,28p' "$0"; exit 0 ;;
    *)                 echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SSH_TARGET="$SERVER_USER@$SERVER_IP"
SSH="ssh -i $SSH_KEY $SSH_TARGET"
SCP="scp -i $SSH_KEY"

# Pull Aliyun creds from the aliyun-start skill's .env so the local
# rds-migrate.sh (step #5) can talk to RDS. The skill ships
# RDS_PUBLIC/RDS_INTRANET, but rds-migrate.sh expects RDS_HOST.
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/aliyun-start}"
if [[ -f "$SKILL_DIR/.env" ]]; then
  set -a; . "$SKILL_DIR/.env"; set +a
fi
: "${RDS_HOST:=${RDS_PUBLIC:-$RDS_INTRANET}}"
: "${RDS_USER:=$RDS_ADMIN}"
export RDS_HOST RDS_USER

log() { echo "[ecs-code-deploy] $*" >&2; }
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "  would: $*"; else eval "$@"; fi
}

# ─── 0. rollback short-circuit ────────────────────────────────────────
if [[ "$ROLLBACK" -eq 1 ]]; then
  log "rollback requested — looking for newest .bak on $SERVER_IP"
  bak=$($SSH "ls -t $SERVER_DIR/server.js.bak.* 2>/dev/null | head -1")
  if [[ -z "$bak" ]]; then
    log "no .bak found, nothing to roll back"; exit 1
  fi
  log "rolling back to $bak"
  run "$SSH \"cp '$bak' '$SERVER_DIR/server.js' && systemctl restart codex-api.service && sleep 2 && curl -sS $HEALTH_URL\""
  exit 0
fi

# ─── 1. validate ──────────────────────────────────────────────────────
log "validate: node -c on local server.js"
if ! node -c "$REPO_DIR/server/server.js"; then
  log "FAIL: server.js has syntax errors; refusing to deploy"
  exit 1
fi
if [[ "$MIGRATIONS_ONLY" -eq 0 ]]; then
  if [[ ! -d "$REPO_DIR/migrations" ]]; then
    log "FAIL: migrations/ dir not found at $REPO_DIR/migrations"; exit 1
  fi
fi

# ─── 2. preflight on SWAS ────────────────────────────────────────────
log "preflight: systemctl is-active on $SERVER_IP"
status=$(eval "$SSH 'systemctl is-active codex-api.service || true'")
if [[ "$status" != "active" && "$status" != "inactive" ]]; then
  log "FAIL: preflight status=$status (expected active or inactive)"; exit 1
fi
log "  current state: $status"

# ─── 3. backup + 4. drop ──────────────────────────────────────────────
if [[ "$SERVER_ONLY" -eq 0 ]]; then
  ts="$(date -u +%Y%m%d-%H%M%S)"
  log "backup existing server.js → server.js.bak.$ts"
  run "$SSH \"cp '$SERVER_DIR/server.js' '$SERVER_DIR/server.js.bak.$ts'\""
  log "drop local server.js → $SERVER_DIR/server.js"
  run "$SCP $REPO_DIR/server/server.js $SSH_TARGET:$SERVER_DIR/server.js"
fi

if [[ "$MIGRATIONS_ONLY" -eq 0 ]]; then
  log "scp migrations/*.sql → $SERVER_DIR/migrations/"
  run "$SSH \"mkdir -p $SERVER_DIR/migrations\""
  for f in "$REPO_DIR"/migrations/*.sql; do
    [[ -f "$f" ]] || continue
    run "$SCP '$f' $SSH_TARGET:$SERVER_DIR/migrations/$(basename "$f")"
  done
fi

# ─── 5. migrate ───────────────────────────────────────────────────────
if [[ "$SERVER_ONLY" -eq 0 ]]; then
  log "apply migrations on $SERVER_IP (via scripts/rds-migrate.sh --ssh, local)"
  run "bash $REPO_DIR/scripts/rds-migrate.sh --ssh"
fi

# ─── 6. restart + 7. verify ───────────────────────────────────────────
log "systemctl restart codex-api.service"
run "$SSH \"systemctl restart codex-api.service\""
log "wait 3s for boot"
run "sleep 3"
log "verify: $HEALTH_URL"
out=$(eval "$SSH \"curl -sS $HEALTH_URL\"" || true)
log "  response: $out"
if ! echo "$out" | grep -q '"ok":true'; then
  log "FAIL: /healthz did not return ok=true — rolling back"
  bak=$($SSH "ls -t $SERVER_DIR/server.js.bak.* 2>/dev/null | head -1")
  if [[ -n "$bak" ]]; then
    log "  restore $bak"
    eval "$SSH \"cp '$bak' '$SERVER_DIR/server.js' && systemctl restart codex-api.service\""
  fi
  exit 1
fi

# ─── 8. log ───────────────────────────────────────────────────────────
log "append deploy line to $SERVER_DIR/deploy.log"
ts_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_line="$ts_iso  server.js=$(node -v 2>/dev/null || echo unknown)  migrations=$(ls "$REPO_DIR"/migrations/*.sql | wc -l | tr -d ' ')  by=${USER:-unknown}"
run "$SSH \"echo '$log_line' >> $SERVER_DIR/deploy.log\""

log "deploy OK"

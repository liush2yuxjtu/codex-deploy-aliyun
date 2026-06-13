#!/usr/bin/env bash
# rotate_credentials.sh — rotate LLM OAuth / RDS password / AccessKey / SSH key
# on the codex-deploy-aliyun stack. DRY-RUN IS THE DEFAULT. --apply to actually
# mutate. Backups go to ~/.credentials.bak/<ts>/ and --rollback <ts> restores.
#
# Usage:
#   scripts/rotate_credentials.sh --only llm                    # dry-run
#   scripts/rotate_credentials.sh --only rds --apply            # real rotation
#   scripts/rotate_credentials.sh --only all --apply            # all four
#   scripts/rotate_credentials.sh --rollback 2026-06-12T101530Z # restore
#
# NEVER logs the new token / password / key value. Only metadata.

set -euo pipefail

# ─── constants ────────────────────────────────────────────────────────────────
SKILL_DIR="$HOME/.claude/skills/aliyun-start"
AL="${ALIYUN_BIN:-$HOME/local/bin/aliyun}"
ENV_FILE="$SKILL_DIR/.env"
SERVER_ENV="/etc/codex-api/secret.env"
BACKUP_ROOT="$HOME/.credentials.bak"
SSH_KEY="$HOME/.ssh/aliyun_deploy"
HEALTHZ_URL="http://127.0.0.1:3030/healthz"
SSH_TARGET="${SERVER_USER:-root}@${SERVER_IP:?SERVER_IP must be set in .env}"

ONLY=""
MODE="dry-run"
ROLLBACK_TS=""

# ─── arg parse ────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --only)    ONLY="$2"; shift 2 ;;
    --apply)   MODE="apply";  shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --rollback)ROLLBACK_TS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

# ─── logging (no secret values) ──────────────────────────────────────────────
log()  { printf '[%s] [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$MODE" "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 69; }; }

# ─── rollback path ───────────────────────────────────────────────────────────
do_rollback() {
  local ts="$1" src="$BACKUP_ROOT/$ts"
  [ -d "$src" ] || { echo "no backup at $src" >&2; exit 1; }
  log "rollback: copying $src/env -> $ENV_FILE"
  cp -p "$src/env" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  log "rollback: scp $src/server-env -> ${SERVER_TARGET:-server}:$SERVER_ENV"
  scp -i "$SSH_KEY" "$src/server-env" "$SSH_TARGET:$SERVER_ENV.new"
  ssh -i "$SSH_KEY" "$SSH_TARGET" "mv $SERVER_ENV.new $SERVER_ENV && systemctl restart codex-api.service"
  curl -fsS "$HEALTHZ_URL" | jq -e '.db.ok == true' >/dev/null && log "rollback: healthz ok" || { log "rollback: healthz FAILED"; exit 1; }
  log "rollback complete"
  exit 0
}

[ -n "$ROLLBACK_TS" ] && do_rollback "$ROLLBACK_TS"

# ─── validation ──────────────────────────────────────────────────────────────
case "$ONLY" in
  llm|rds|ak|ssh|all) ;;
  "") echo "--only {llm|rds|ak|ssh|all} is required" >&2; exit 64 ;;
  *)  echo "bad --only value: $ONLY" >&2; exit 64 ;;
esac

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
need aliyun; need ssh; need scp; need curl; need ssh-keygen; need jq

# ─── backup current state ────────────────────────────────────────────────────
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
BAK="$BACKUP_ROOT/$TS"
mkdir -p "$BAK"
cp -p "$ENV_FILE" "$BAK/env"
ssh -i "$SSH_KEY" "$SSH_TARGET" "cat $SERVER_ENV" > "$BAK/server-env" 2>/dev/null || true
chmod 700 "$BAK"
log "backup written to $BAK"

# ─── sub-action helpers ──────────────────────────────────────────────────────
# Each helper:
#   - in dry-run: prints "would rotate X via Y API" and metadata
#   - in apply: calls aliyun CLI, captures only the new value length, writes env
rotate_llm() {
  log "rotate LLM: would call RAM reissue OR provider OAuth refresh"
  log "  current LLM_API_KEY length=${#LLM_API_KEY}"
  if [ "$MODE" = "apply" ]; then
    # NewCLI/Anthropic OAuth refresh — provider-specific URL, placeholder.
    local new=""
    new=$(curl -fsS -X POST \
      "${LLM_OAUTH_REFRESH_URL:-https://api.anthropic.com/v1/oauth/refresh}" \
      -H "Authorization: Bearer $LLM_API_KEY" \
      -d "grant_type=refresh_token&refresh_token=${LLM_OAUTH_REFRESH_TOKEN:-}" \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
    [ -n "$new" ] || { log "LLM refresh returned empty"; return 1; }
    log "  new LLM_API_KEY length=${#new}"
    sed -i.bak "s|^LLM_API_KEY=.*|LLM_API_KEY=$new|" "$ENV_FILE"
  fi
}

rotate_rds() {
  log "rotate RDS: would call rds ResetAccountPassword --accountName $RDS_ADMIN"
  log "  current RDS_PASSWORD length=${#RDS_PASSWORD}"
  if [ "$MODE" = "apply" ]; then
    # 24-char random from [A-Za-z0-9], psql + libpq-ok charset (no quotes/colons).
    local npw
    npw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    "$AL" rds ResetAccountPassword \
      --region "$RDS_REGION" --DBInstanceId "$RDS_INSTANCE_ID" \
      --AccountName "$RDS_ADMIN" --AccountPassword "$npw" >/dev/null
    log "  new RDS_PASSWORD length=${#npw}"
    sed -i.bak "s|^RDS_PASSWORD=.*|RDS_PASSWORD=$npw|" "$ENV_FILE"
  fi
}

rotate_ak() {
  log "rotate AK: would call ram CreateAccessKey + Disable older"
  log "  current ALIBABA_CLOUD_ACCESS_KEY_ID length=${#ALIBABA_CLOUD_ACCESS_KEY_ID}"
  if [ "$MODE" = "apply" ]; then
    local kid ksec
    kid=$("$AL" ram CreateAccessKey --region "$ALIYUN_REGION" \
      | python3 -c "import json,sys;print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
    ksec=$("$AL" ram CreateAccessKey --region "$ALIYUN_REGION" \
      | python3 -c "import json,sys;print(json.load(sys.stdin)['AccessKey']['AccessKeySecret'])")
    [ -n "$kid" ] && [ -n "$ksec" ] || { log "CreateAccessKey returned empty"; return 1; }
    log "  new AK id length=${#kid} secret length=${#ksec}"
    "$AL" ram UpdateAccessKeyStatus --region "$ALIYUN_REGION" \
      --UserAccessKeyId "$ALIBABA_CLOUD_ACCESS_KEY_ID" --Status Inactive >/dev/null
    sed -i.bak \
      -e "s|^ALIBABA_CLOUD_ACCESS_KEY_ID=.*|ALIBABA_CLOUD_ACCESS_KEY_ID=$kid|" \
      -e "s|^ALIBABA_CLOUD_ACCESS_KEY_SECRET=.*|ALIBABA_CLOUD_ACCESS_KEY_SECRET=$ksec|" \
      "$ENV_FILE"
  fi
}

rotate_ssh() {
  log "rotate SSH: would ssh-keygen ed25519 + scp pubkey to SWAS"
  log "  current SSH_KEY=$SSH_KEY"
  if [ "$MODE" = "apply" ]; then
    local new="$HOME/.ssh/aliyun_deploy.${TS}"
    ssh-keygen -t ed25519 -N '' -f "$new" -C "codex-deploy-aliyun ${TS}" >/dev/null
    ssh -i "$SSH_KEY" "$SSH_TARGET" "mkdir -p ~/.ssh && chmod 700 ~/.ssh" \
      < /dev/null
    scp -i "$SSH_KEY" "$new.pub" "$SSH_TARGET:/tmp/aliyun_deploy.pub.new"
    ssh -i "$SSH_KEY" "$SSH_TARGET" \
      "cat /tmp/aliyun_deploy.pub.new >> ~/.ssh/authorized_keys && rm /tmp/aliyun_deploy.pub.new"
    log "  new key fingerprint: $(ssh-keygen -lf "$new" | awk '{print $2}')"
    sed -i.bak "s|^SSH_KEY=.*|SSH_KEY=$new|" "$ENV_FILE"
    chmod 600 "$new"
  fi
}

# ─── dispatch ────────────────────────────────────────────────────────────────
case "$ONLY" in
  llm) rotate_llm ;;
  rds) rotate_rds ;;
  ak)  rotate_ak  ;;
  ssh) rotate_ssh ;;
  all) rotate_llm && rotate_ak && rotate_rds && rotate_ssh || {
        log "all-mode failed at step, restoring backup $BAK"
        cp -p "$BAK/env" "$ENV_FILE"; chmod 600 "$ENV_FILE"
        exit 1; } ;;
esac

# ─── push + restart + healthcheck (apply only) ───────────────────────────────
if [ "$MODE" = "apply" ]; then
  chmod 600 "$ENV_FILE"
  log "pushing updated $ENV_FILE -> $SSH_TARGET:$SERVER_ENV"
  scp -i "$SSH_KEY" "$ENV_FILE" "$SSH_TARGET:$SERVER_ENV.new"
  ssh -i "$SSH_KEY" "$SSH_TARGET" \
    "mv $SERVER_ENV.new $SERVER_ENV && systemctl restart codex-api.service"
  log "checking $HEALTHZ_URL"
  if curl -fsS "$HEALTHZ_URL" | jq -e '.db.ok == true' >/dev/null; then
    log "healthz ok: db.live"
  else
    log "healthz FAILED — manual review at $BAK"
    exit 1
  fi
fi

log "done. backup at $BAK"

#!/usr/bin/env bash
# setup_sls_logstore.sh — idempotent creator of the SLS project + logstore
# that codex-api will ship structured logs to (ISSUE-024). Replaces
# `journalctl -u codex-api.service -f` with a SLS dashboard / PullLogs query.
#
# Usage:
#   scripts/setup_sls_logstore.sh                 # create project + logstore
#   scripts/setup_sls_logstore.sh --status        # show what exists
#   scripts/setup_sls_logstore.sh --ram-user codexsbx --policy-put
#                                                # also grant codexsbx sls:PutLogLines
#   scripts/setup_sls_logstore.sh --project codex-deploy-aliyun
#   scripts/setup_sls_logstore.sh --logstore codex-api
#   scripts/setup_sls_logstore.sh --region cn-shanghai
#
# Why this script: 024 spec requires project + logstore + index + RAM grant
# to be reproducible from a single command. Running twice is a no-op (the
# SLS APIs return 409 / 400 on duplicate, which we detect and ignore).
#
# Credentials: same ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET as the rest of the
# repo. Source ~/.claude/skills/aliyun-start/.env or scripts/rotate_credentials.sh
# output. NO secrets are echoed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/aliyun-start}"
if [[ -f "$SKILL_DIR/.env" ]]; then
  set -a; . "$SKILL_DIR/.env"; set +a
fi

: "${ALIBABA_CLOUD_ACCESS_KEY_ID:?set ALIBABA_CLOUD_ACCESS_KEY_ID (e.g. source $SKILL_DIR/.env)}"
: "${ALIBABA_CLOUD_ACCESS_KEY_SECRET:?set ALIBABA_CLOUD_ACCESS_KEY_SECRET}"

REGION="${ALIYUN_REGION:-cn-shanghai}"
PROJECT="${SLS_PROJECT:-codex-deploy-aliyun}"
LOGSTORE="${SLS_LOGSTORE:-codex-api}"
SHARD_COUNT="${SLS_SHARD_COUNT:-2}"
LIFECYCLE_DAYS="${SLS_LIFECYCLE_DAYS:-30}"
RAM_USER="${RAM_USER:-codexsbx}"
POLICY_PUT=0
STATUS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)      STATUS_ONLY=1; shift ;;
    --ram-user)    RAM_USER="$2"; shift 2 ;;
    --policy-put)  POLICY_PUT=1; shift ;;
    --project)     PROJECT="$2"; shift 2 ;;
    --logstore)    LOGSTORE="$2"; shift 2 ;;
    --region)      REGION="$2"; shift 2 ;;
    -h|--help)     sed -n '2,22p' "$0"; exit 0 ;;
    *)             echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── helpers ───────────────────────────────────────────────────────────
# aliyun-cli SLS APIs use a generic PUT/POST/DELETE under /sls/<api>. We
# route through the same wrapper for readability and to mask the JSON
# body boilerplate.
sls_call() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  if [[ -n "$body" ]]; then
    aliyun sls "$method" "$path" --body "$body" 2>&1
  else
    aliyun sls "$method" "$path" 2>&1
  fi
}

# Returns 0 if the project already exists, 1 if not. Pulls the JSON status
# out of the response. Does NOT exit on a 4xx (project-not-found is the
# expected "not yet created" signal).
project_exists() {
  local out
  out=$(sls_call GET "/projects/$PROJECT" 2>&1 || true)
  if echo "$out" | grep -q '"name"'; then
    return 0
  fi
  return 1
}

logstore_exists() {
  local out
  out=$(sls_call GET "/logstores" 2>&1 || true)
  if echo "$out" | grep -q "\"$LOGSTORE\""; then
    return 0
  fi
  return 1
}

# ─── status ────────────────────────────────────────────────────────────
if [[ "$STATUS_ONLY" -eq 1 ]]; then
  echo "── SLS status ──"
  echo "region   : $REGION"
  echo "project  : $PROJECT"
  if project_exists; then echo "  ✓ exists"; else echo "  ✗ missing"; fi
  echo "logstore : $LOGSTORE"
  if logstore_exists; then echo "  ✓ exists"; else echo "  ✗ missing"; fi
  exit 0
fi

# ─── create project (idempotent) ──────────────────────────────────────
echo "── ensure project ──"
if project_exists; then
  echo "  ✓ $PROJECT already present"
else
  echo "  + creating $PROJECT in $REGION (ttl=$LIFECYCLE_DAYS days)"
  sls_call POST "/projects" "$(cat <<JSON
{"projectName":"$PROJECT","description":"codex-deploy-aliyun structured logs (ISSUE-024)"}
JSON
  )" >/dev/null
  # The create-project API is async; poll briefly.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if project_exists; then echo "    ready after ${i}s"; break; fi
    sleep 1
  done
fi

# ─── create logstore (idempotent) ─────────────────────────────────────
echo "── ensure logstore ──"
if logstore_exists; then
  echo "  ✓ $LOGSTORE already present"
else
  echo "  + creating $LOGSTORE (shard=$SHARD_COUNT ttl=${LIFECYCLE_DAYS}d)"
  sls_call POST "/logstores" "$(cat <<JSON
{"logstoreName":"$LOGSTORE","shardCount":$SHARD_COUNT,"ttl":$LIFECYCLE_DAYS,"enable_tracking":false}
JSON
  )" >/dev/null
  for i in 1 2 3 4 5; do
    if logstore_exists; then echo "    ready after ${i}s"; break; fi
    sleep 1
  done
fi

# ─── create / replace index (ISSUE-024 schema) ────────────────────────
# Fields surfaced by logToSls(): ts, level, message, requestId, jobId, route,
# statusCode, durationMs, source, ok, quotaExceeded, codexSessionId.
echo "── ensure index ──"
INDEX_BODY=$(cat <<JSON
{
  "indexName": "codex-api",
  "keys": {
    "ts":           {"type": "text",   "token": [",", " ", "\t", "\n", ";"], "case_sensitive": false, "alias": ""},
    "level":        {"type": "text",   "token": [","], "case_sensitive": false},
    "message":      {"type": "text",   "token": [","], "case_sensitive": false},
    "requestId":    {"type": "text",   "token": [","], "case_sensitive": false},
    "jobId":        {"type": "text",   "token": [","], "case_sensitive": false},
    "runId":        {"type": "text",   "token": [","], "case_sensitive": false},
    "route":        {"type": "text",   "token": [","], "case_sensitive": false},
    "statusCode":   {"type": "long"},
    "durationMs":   {"type": "long"},
    "quotaExceeded":{"type": "boolean"},
    "ok":           {"type": "boolean"}
  },
  "ttl": $LIFECYCLE_DAYS,
  "lastModifyTime": $(date +%s)
}
JSON
)
sls_call PUT "/logstores/$LOGSTORE/index" "$INDEX_BODY" >/dev/null
echo "  ✓ index 'codex-api' upserted"

# ─── RAM grant: codexsbx user can PutLogLines ────────────────────────
# Custom inline policy scoped to this project + logstore only. Created
# once, attached to the user if --policy-put is requested.
if [[ "$POLICY_PUT" -eq 1 ]]; then
  echo "── RAM grant ──"
  POLICY_NAME="SlsPutLogLines-$PROJECT-$LOGSTORE"
  POLICY_DOC=$(cat <<JSON
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sls:PutLogLines"],
    "Resource": [
      "acs:sls:$REGION:*:project/$PROJECT/logstore/$LOGSTORE"
    ]
  }]
}
JSON
)
  # Create or update the policy. Detach + re-attach so a previous broken
  # binding (e.g. resource change) is replaced.
  if aliyun ram ListPolicies --PolicyType Custom 2>/dev/null | grep -q "$POLICY_NAME"; then
    echo "  ✓ policy $POLICY_NAME already exists"
  else
    echo "  + creating policy $POLICY_NAME"
    aliyun ram CreatePolicy \
      --PolicyName "$POLICY_NAME" \
      --PolicyDocument "$POLICY_DOC" >/dev/null
  fi
  aliyun ram AttachPolicyToUser \
    --UserName "$RAM_USER" \
    --PolicyName "$POLICY_NAME" \
    --PolicyType Custom >/dev/null
  echo "  ✓ attached to user $RAM_USER"
fi

# ─── write .env hint (no secrets) ────────────────────────────────────
# Drop the public endpoint + project + logstore into .env.example-like
# lines so the operator can copy them into the server's secret.env.
cat <<ENV
── env vars to add to /etc/codex-api/secret.env ──
SLS_ENDPOINT=$REGION.log.aliyuncs.com
SLS_PROJECT=$PROJECT
SLS_LOGSTORE=$LOGSTORE
ENV

echo "── done ──"

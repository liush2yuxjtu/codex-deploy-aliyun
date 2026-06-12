#!/usr/bin/env bash
# sls-tail.sh — SSH-less equivalent of `journalctl -u codex-api.service -f`.
# Pulls structured logs from Aliyun SLS via the GetLogs API, optionally
# filters by time range, level, or a free-text grep.
#
# Usage:
#   scripts/sls-tail.sh                          # last 5m, all levels, follow
#   scripts/sls-tail.sh --since 5m --follow      # alias for default
#   scripts/sls-tail.sh --since 1h --level error
#   scripts/sls-tail.sh --since 30m --grep quotaExceeded
#   scripts/sls-tail.sh --job <jobId> --follow
#   scripts/sls-tail.sh --no-follow --limit 200
#   scripts/sls-tail.sh --project codex-deploy-aliyun --logstore codex-api
#
# Why: 024 spec acceptance criteria — `journalctl -f` requires SSH into
# the SWAS box; this is the same UX from any host with SLS creds.

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
SINCE="5m"
LEVEL=""
GREP=""
JOB_ID=""
FOLLOW=1
LIMIT=500

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)     SINCE="$2"; shift 2 ;;
    --level)     LEVEL="$2"; shift 2 ;;
    --grep)      GREP="$2"; shift 2 ;;
    --job)       JOB_ID="$2"; shift 2 ;;
    --no-follow) FOLLOW=0; shift ;;
    --follow|-f) FOLLOW=1; shift ;;
    --limit)     LIMIT="$2"; shift 2 ;;
    --project)   PROJECT="$2"; shift 2 ;;
    --logstore)  LOGSTORE="$2"; shift 2 ;;
    --region)    REGION="$2"; shift 2 ;;
    -h|--help)   sed -n '2,16p' "$0"; exit 0 ;;
    *)           echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── time range: --since accepts "5m", "1h", "30s", or an epoch ────────
to_epoch() {
  local s="$1"
  if [[ "$s" =~ ^[0-9]+$ ]]; then echo "$s"; return; fi
  local n="${s%[smhd]*}"
  case "$s" in
    *m) echo $(($(date +%s) - n * 60)) ;;
    *h) echo $(($(date +%s) - n * 3600)) ;;
    *d) echo $(($(date +%s) - n * 86400)) ;;
    *s) echo $(($(date +%s) - n)) ;;
    *)  echo "$s" ;;
  esac
}
FROM_TS=$(to_epoch "$SINCE")
TO_TS=$(date +%s)

# ─── query: build the SLS filter expression ───────────────────────────
# We always pull everything in the time window and let grep/jq narrow
# client-side; the SLS GetLogs query language (level:error AND ...) is
# brittle to escape, and the result is already small.
build_query() {
  local q=""
  if [[ -n "$LEVEL" ]]; then q+="level:${LEVEL}"; fi
  if [[ -n "$JOB_ID" ]]; then q+="${q:+ AND }jobId:${JOB_ID}"; fi
  if [[ -n "$GREP" ]];  then q+="${q:+ AND }message:${GREP}"; fi
  if [[ -z "$q" ]]; then q="*"; fi
  echo "$q"
}
QUERY=$(build_query)

# ─── one-shot pull: print lines, oldest first ─────────────────────────
pull_once() {
  local from="$1" to="$2"
  local body
  body=$(cat <<JSON
{
  "from": $from,
  "to":   $to,
  "query": "$(printf '%s' "$QUERY" | sed 's/"/\\"/g')",
  "limit": $LIMIT,
  "line": $((from * 1000000)),
  "offset": 0,
  "reverse": false,
  "powerSql": false
}
JSON
  )
  aliyun sls POST "/logstores/$LOGSTORE/shards/lb" \
    --body "$body" 2>/dev/null \
  | jq -r '
      .data // [] | .[]? |
      "[\(.ts // "?" | .[0:10] | tonumber | strftime("%Y-%m-%dT%H:%M:%S%z"))] " +
      (.level // "info") + " " +
      (.message // "") + " " +
      (if .jobId      then " jobId=\(.jobId)"      else "" end) +
      (if .requestId  then " req=\(.requestId)"     else "" end) +
      (if .route      then " route=\(.route)"       else "" end) +
      (if .statusCode != null then " status=\(.statusCode)" else "" end) +
      (if .durationMs != null then " ms=\(.durationMs)"     else "" end) +
      (if .quotaExceeded == true then " QUOTA_EXCEEDED" else "" end)
    ' 2>/dev/null
}

# ─── follow loop (polling) ────────────────────────────────────────────
if [[ "$FOLLOW" -eq 1 ]]; then
  # print the recent window first
  pull_once "$FROM_TS" "$TO_TS"
  LAST_TO=$TO_TS
  while :; do
    sleep 2
    NOW=$(date +%s)
    if (( NOW > LAST_TO )); then
      pull_once "$LAST_TO" "$NOW" || true
      LAST_TO=$NOW
    fi
  done
else
  pull_once "$FROM_TS" "$TO_TS"
fi

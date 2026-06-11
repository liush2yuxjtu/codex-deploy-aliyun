#!/usr/bin/env bash
# remote_exec.sh — submit a shell script to SWAS run-command and poll until done.
# Usage: remote_exec.sh <name> <timeout_seconds> <script_file>
set -euo pipefail

SKILL_DIR="$HOME/.claude/skills/aliyun-start"
# shellcheck disable=SC1091
set -a; . "$SKILL_DIR/.env"; set +a
AL="$HOME/.local/bin/aliyun"

NAME="$1"
TIMEOUT="${2:-600}"
SCRIPT_FILE="$3"

SCRIPT_CONTENT="$(cat "$SCRIPT_FILE")"

INVOKE=$("$AL" swas-open run-command \
  --profile "$ALIYUN_PROFILE" \
  --region cn-shanghai --biz-region-id cn-shanghai \
  --instance-id "$SWAS_INSTANCE_ID" \
  --name "$NAME" --type RunShellScript \
  --timeout "$TIMEOUT" \
  --command-content "$SCRIPT_CONTENT")

IID=$(printf '%s' "$INVOKE" | python3 -c "import json,sys;print(json.load(sys.stdin)['InvokeId'])")
echo "[invoke $IID name=$NAME timeout=${TIMEOUT}s]" >&2

MAX_POLLS=$(( TIMEOUT / 5 + 20 ))
for ((i=1; i<=MAX_POLLS; i++)); do
  sleep 5
  OUT=$("$AL" swas-open describe-command-invocations \
    --profile "$ALIYUN_PROFILE" \
    --region cn-shanghai --biz-region-id cn-shanghai \
    --invoke-id "$IID")
  STATUS=$(printf '%s' "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ci=d['CommandInvocations'][0]
print(ci['InvocationStatus'])
")
  echo "[poll $i/$MAX_POLLS] $STATUS" >&2
  case "$STATUS" in
    Success|Failed)
      printf '%s' "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ci=d['CommandInvocations'][0]
ii=ci['InvokeInstances'][0]
print('===== OUTPUT =====')
print(ii.get('Output',''))
print('===== exit_code=', ii.get('ExitCode'), 'error=', ii.get('ErrorInfo',''), '=====')
"
      [ "$STATUS" = "Success" ] && exit 0 || exit 2
      ;;
    Running|Pending) ;;
    *) echo "unknown status: $STATUS" >&2; exit 3 ;;
  esac
done
echo "TIMEOUT after $MAX_POLLS polls" >&2
exit 4

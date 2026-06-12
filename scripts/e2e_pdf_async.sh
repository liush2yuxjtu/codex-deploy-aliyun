#!/usr/bin/env bash
# e2e_pdf_async.sh — end-to-end smoke for the /pdf/from-url?async=1 path
# landed in 5c1d546 + 2ad57c7. Exercises:
#   1. 202 + jobId on POST /pdf/from-url?async=1
#   2. SSE stream delivers pdf-start → pdf-line* → pdf-done
#   3. downloadUrl/fileUrl in pdf-done resolves to a real PDF binary
#   4. stderr_tail surfaces in the 5xx shape when the script fails
#
# Run: bash scripts/e2e_pdf_async.sh [host]
# Default host: http://127.0.0.1:3030 (override with $HOST or first arg)

set -uo pipefail

HOST="${1:-${HOST:-http://127.0.0.1:3030}}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
hr() { printf '\n── %s ──\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; PASS=$((PASS+1)); }
no()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL+1)); }

# ─── Test 1: happy path returns 202 + jobId ──────────────────────────
hr "T1: POST /pdf/from-url?async=1 returns 202 + jobId"
RESP="$TMP/r1.json"
HTTP=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST "$HOST/pdf/from-url?async=1" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","slug":"e2e-happy"}' || true)
[[ "$HTTP" == "202" ]] && ok "HTTP 202" || no "expected 202, got $HTTP"
JOB_ID=$(python3 -c "import json,sys; print(json.load(open('$RESP')).get('jobId',''))" 2>/dev/null || echo "")
[[ -n "$JOB_ID" ]] && ok "jobId=$JOB_ID" || no "no jobId in response ($(cat "$RESP"))"
EVENTS_URL=$(python3 -c "import json,sys; print(json.load(open('$RESP')).get('eventsUrl',''))" 2>/dev/null || echo "")
[[ -n "$EVENTS_URL" ]] && ok "eventsUrl=$EVENTS_URL" || no "no eventsUrl"

# ─── Test 2: SSE stream delivers pdf-start → pdf-line* → pdf-done ────
hr "T2: SSE stream $EVENTS_URL"
SSE="$TMP/sse.log"
# 60s max; pdf-done terminates the stream on the server side
curl -sS -N --max-time 60 "$HOST$EVENTS_URL" > "$SSE" 2>/dev/null &
SSE_PID=$!
# poll for terminal event
for i in $(seq 1 60); do
  if grep -qE '^event: pdf-done$|^event: pdf-error$' "$SSE" 2>/dev/null; then break; fi
  sleep 1
done
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true

grep -qE '^event: pdf-start$' "$SSE" && ok "pdf-start received" || no "no pdf-start"
LINE_COUNT=$(grep -cE '^event: pdf-line$' "$SSE" || true)
if [[ "$LINE_COUNT" -ge 1 ]]; then ok "$LINE_COUNT pdf-line events"; else no "no pdf-line events"; fi
grep -qE '^event: pdf-done$' "$SSE" && ok "pdf-done received" || no "no pdf-done"
STATE=$(grep -m1 '^event: snapshot$' "$SSE" -A1 | tail -1 | sed 's/^data: //' | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || echo "")
case "$STATE" in
  pending|done) ok "snapshot.state=$STATE (valid)" ;;
  *)            no "snapshot.state=$STATE (unexpected)" ;;
esac

# ─── Test 3: pdf-done event includes downloadable fileUrl ───────────
hr "T3: pdf-done carries a fetchable fileUrl"
FILE_URL=$(grep -E '^event: pdf-done$' "$SSE" -A1 | tail -1 | sed 's/^data: //' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('fileUrl',''))" 2>/dev/null || echo "")
if [[ -n "$FILE_URL" ]]; then
  HTTP=$(curl -sS -o "$TMP/pdf.bin" -w '%{http_code}' "$HOST$FILE_URL" || true)
  if [[ "$HTTP" == "200" ]] && head -c 4 "$TMP/pdf.bin" | grep -q '%PDF'; then
    ok "GET $FILE_URL → 200 + %PDF header ($(wc -c < "$TMP/pdf.bin") bytes)"
  else
    no "GET $FILE_URL → HTTP $HTTP, head: $(head -c 16 "$TMP/pdf.bin" | xxd | head -1)"
  fi
else
  no "no fileUrl in pdf-done event"
fi

# ─── Test 4: stderr_tail surfaces on script failure ──────────────────
hr "T4: bad URL surfaces stderr_tail"
RESP4="$TMP/r4.json"
HTTP=$(curl -sS -o "$RESP4" -w '%{http_code}' \
  -X POST "$HOST/pdf/from-url" \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:1/never-reachable","slug":"e2e-fail"}' || true)
if [[ "$HTTP" =~ ^5 ]]; then
  ok "HTTP $HTTP (expected 5xx for unreachable URL)"
  ERR=$(python3 -c "import json; d=json.load(open('$RESP4')); print(d.get('error',''))" 2>/dev/null || echo "")
  TAIL=$(python3 -c "import json; d=json.load(open('$RESP4')); print(len(d.get('stderr_tail','')))" 2>/dev/null || echo "0")
  [[ -n "$ERR" ]] && ok "error field set: $ERR" || no "no error field"
  [[ "$TAIL" -gt 0 ]] && ok "stderr_tail present ($TAIL chars)" || no "stderr_tail missing or empty"
else
  no "expected 5xx, got $HTTP — body: $(cat "$RESP4" | head -c 200)"
fi

# ─── Summary ─────────────────────────────────────────────────────────
hr "Result"
echo "  pass=$PASS  fail=$FAIL"
exit $((FAIL > 0 ? 1 : 0))

#!/usr/bin/env bash
# diagnose_reachability.sh — SWAS → RDS network reachability check.
#
# Paving the way for v3 cn-shanghai RDS recreate: prove (or disprove) that
# SWAS-cs (cn-shanghai) and RDS-cb (cn-hangzhou) only talk via the public
# endpoint, with no cross-region VPC peering / CEN. Read-only.
#
# Usage:
#   scripts/diagnose_reachability.sh          # run locally
#   scripts/diagnose_reachability.sh --ssh    # run from SWAS via SSH
#   scripts/diagnose_reachability.sh --json   # machine-readable
#
# v3 #3: ISSUE-023 — see docs/issues/023-network-reachability.md
set -uo pipefail

# ─── creds / paths ─────────────────────────────────────────────────────
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/aliyun-start}"
[[ -f "$SKILL_DIR/.env" ]] && { set -a; . "$SKILL_DIR/.env"; set +a; }
: "${RDS_PUBLIC:?RDS_PUBLIC not set (source $SKILL_DIR/.env)}"
: "${RDS_HOST:=$RDS_PUBLIC}"; : "${RDS_PORT:=5432}"; : "${RDS_INTRANET:=}"
: "${RDS_INSTANCE_ID:=}"
: "${SWAS_INSTANCE_ID:?SWAS_INSTANCE_ID not set}"
: "${SWAS_REGION:=cn-shanghai}"; : "${RDS_REGION:=cn-hangzhou}"
: "${ALIYUN_PROFILE:=myaliyun}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/aliyun_deploy}"
SERVER_IP="${SERVER_IP:-106.14.154.23}"
AL="${AL:-$HOME/.local/bin/aliyun}"

# ─── args ──────────────────────────────────────────────────────────────
JSON_MODE=0; USE_SSH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=1; shift ;;
    --ssh)  USE_SSH=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ssh wrap: in-band checks must reflect SWAS's view
on_swas() { hostname -I 2>/dev/null | grep -q "$SERVER_IP" || hostname | grep -qi swas; }
[[ "$USE_SSH" -eq 1 ]] && on_swas && { echo "[diagnose] --ssh ignored: already on $SERVER_IP" >&2; USE_SSH=0; }
run_raw() {
  [[ "$USE_SSH" -eq 1 ]] && ssh -i "$SSH_KEY" -o ConnectTimeout=10 "root@$SERVER_IP" "$@" || "$@"
}

# ─── result buffer + helpers ───────────────────────────────────────────
RESULTS=(); S_OK=0; S_FAIL=0; S_SKIP=0
add() { RESULTS+=("$1|$2|$3"); case "$2" in OK)S_OK=$((S_OK+1));; FAIL)S_FAIL=$((S_FAIL+1));; SKIP)S_SKIP=$((S_SKIP+1));; esac; }
py_pick() { python3 -c "import json,sys
try: d=json.loads(sys.stdin.read().strip() or '{}')
except Exception: d={}
k=sys.argv[1]
for path in ((k,), ('Items','DBInstanceAttribute',0,k), ('Instances',0,k)):
  v=d
  for p in path:
    if isinstance(v,dict): v=v.get(p)
    elif isinstance(v,list) and isinstance(p,int) and p<len(v): v=v[p]
    else: v=''; break
  if v: print(v); sys.exit(0)" "$1"; }

py_count() { python3 -c "import json,sys
try: d=json.loads(sys.stdin.read().strip() or '{}')
except Exception: print('err'); sys.exit(0)
for k in sys.argv[1:]:
  v=d
  for p in k.split('.'):
    if isinstance(v,dict) and p in v: v=v[p]
    else: v=[]; break
  if isinstance(v,list): print(len(v)); sys.exit(0)
print('err')" "$@"; }

py_emit() { python3 -c "import json,os; e=os.environ; buf=e.get('DIAG_RESULTS','')
items=[dict(zip(('name','status','detail'),ln.split('|',2))) for ln in buf.splitlines() if ln]
out={'generated_at':int(e.get('DIAG_TS','0')),'swas_instance_id':e.get('SWAS_INSTANCE_ID',''),
     'swas_region':e.get('SWAS_REGION',''),'rds_host':e.get('RDS_HOST',''),
     'rds_public':e.get('RDS_PUBLIC',''),'rds_intranet':e.get('RDS_INTRANET',''),
     'rds_region':e.get('RDS_REGION',''),'rds_port':int(e.get('RDS_PORT','5432')),
     'ran_via_ssh':e.get('USE_SSH','0')=='1',
     'summary':{'ok':int(e.get('S_OK','0')),'fail':int(e.get('S_FAIL','0')),'skip':int(e.get('S_SKIP','0'))},
     'results':items}
print(json.dumps(out, indent=2, ensure_ascii=False))"; }

# ─── checks ────────────────────────────────────────────────────────────
# Generic aliyun metadata call. args: <name> <product> <op> [extra args...]
cloud_meta() {
  local name="$1" product="$2" op="$3"; shift 3
  command -v "$AL" >/dev/null 2>&1 || { add "$name" SKIP "aliyun CLI not installed"; return; }
  local out region_v vpc
  out="$("$AL" "$product" "$op" --profile "$ALIYUN_PROFILE" "$@" 2>/dev/null)" \
    || { add "$name" SKIP "aliyun call failed (check AccessKey / RAM perms)"; return; }
  region_v="$(printf '%s' "$out" | py_pick RegionId)"; vpc="$(printf '%s' "$out" | py_pick VpcId)"
  [[ -n "$region_v" || -n "$vpc" ]] && add "$name" OK "region=${region_v:-?} vpc=${vpc:-?}" \
    || add "$name" SKIP "no parseable ${name} metadata"
}
swas_meta() { [[ -n "$SWAS_INSTANCE_ID" ]] && cloud_meta swas_meta swas-open list-instances \
  --region "$SWAS_REGION" --biz-region-id "$SWAS_REGION" --instance-ids "[\"$SWAS_INSTANCE_ID\"]" \
  || add swas_meta SKIP "SWAS_INSTANCE_ID not set"; }
rds_meta() { [[ -n "$RDS_INSTANCE_ID" ]] && cloud_meta rds_meta rds DescribeDBInstanceAttribute \
  --region "$RDS_REGION" --DBInstanceId "$RDS_INSTANCE_ID" \
  || add rds_meta SKIP "RDS_INSTANCE_ID not set"; }

vpc_peering_check() {
  command -v "$AL" >/dev/null 2>&1 || { add vpc_peering SKIP "aliyun CLI not installed"; return; }
  local peer cen out1 out2
  out1="$("$AL" vpc DescribeVpcPeeringConnections --profile "$ALIYUN_PROFILE" --region "$SWAS_REGION" 2>/dev/null)"
  peer="$(printf '%s' "$out1" | py_count VpcPeeringConnections.VpcPeeringConnection)"
  out2="$("$AL" cen DescribeCens --profile "$ALIYUN_PROFILE" --region "$SWAS_REGION" 2>/dev/null)"
  cen="$(printf '%s' "$out2" | py_count Cens.Cen)"
  if [[ "$peer" == "err" || "$cen" == "err" || -z "$out1" || -z "$out2" ]]; then
    add vpc_peering SKIP "vpc/cen Describe unavailable (RAM perm or API mismatch)"; return
  fi
  if [[ "$peer" == "0" && "$cen" == "0" ]]; then
    add vpc_peering OK "no peering, no CEN in $SWAS_REGION — public-only path expected"
  else
    add vpc_peering FAIL "$peer peering(s) + $cen CEN(s) in $SWAS_REGION — investigate"
  fi
}

ping_public() {
  command -v ping >/dev/null 2>&1 || { add ping_public SKIP "ping not installed"; return; }
  local out loss rtt
  out="$(run_raw bash -c "ping -c 3 -W 2 '$RDS_PUBLIC'" 2>&1)" || true
  loss="$(printf '%s\n' "$out" | grep -oE '[0-9]+% packet loss' | head -1 || true)"
  rtt="$(printf '%s\n' "$out" | grep -oE 'min/avg/[^=]+= [0-9.]+/[0-9.]+/[0-9.]+' | head -1 || true)"
  if printf '%s' "$out" | grep -qE "Network is unreachable|unknown host|Name or service not known"; then
    add ping_public FAIL "$RDS_PUBLIC unreachable"
  elif [[ "$loss" == "100% packet loss" ]]; then
    add ping_public FAIL "$RDS_PUBLIC 100% packet loss (ICMP blocked, not necessarily broken)"
  else
    add ping_public OK "$RDS_PUBLIC loss=${loss:-0%} ${rtt:-}"
  fi
}

nc_public() {
  command -v nc >/dev/null 2>&1 || { add nc_public SKIP "nc not installed"; return; }
  if run_raw bash -c "nc -z -w 3 '$RDS_HOST' '$RDS_PORT'" 2>/dev/null; then
    add nc_public OK "$RDS_HOST:$RDS_PORT accepts TCP"
  else add nc_public FAIL "$RDS_HOST:$RDS_PORT refuses TCP"; fi
}

curl_egress_ip() {
  command -v curl >/dev/null 2>&1 || { add egress_ip SKIP "curl not installed"; return; }
  local ip; ip="$(run_raw curl -s --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then add egress_ip OK "outbound IP = $ip"
  else add egress_ip FAIL "could not determine outbound IP (got: ${ip:-empty})"; fi
}

route_table() {
  local gw
  if command -v ip >/dev/null 2>&1; then
    gw="$(run_raw ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
  elif command -v route >/dev/null 2>&1; then
    gw="$(run_raw route -n 2>/dev/null | awk '$1=="0.0.0.0" {print $2; exit}')"
  fi
  [[ -n "${gw:-}" ]] && add route OK "default gateway = $gw" \
    || add route SKIP "no default route (neither ip nor route usable here)"
}

mtu_check() {  # Linux: ip -o link. macOS: ifconfig.
  local mtu=""
  if command -v ip >/dev/null 2>&1; then
    mtu="$(run_raw bash -c 'IF=$(ip route | awk "/^default/{print \$5; exit}"); ip -o link show "$IF" 2>/dev/null | grep -oE "mtu [0-9]+" | head -1 | awk "{print \$2}"')"
  elif command -v ifconfig >/dev/null 2>&1; then
    mtu="$(run_raw ifconfig 2>/dev/null | grep -oE 'mtu [0-9]+' | head -1 | awk '{print $2}')"
  fi
  [[ -n "$mtu" ]] && add mtu OK "interface MTU = $mtu" || add mtu SKIP "could not determine MTU"
}

# Intranet hostname resolves to a private IP — only meaningful when run from
# inside a VPC (use --ssh). On a Mac, DNS may resolve to the public endpoint.
intranet_check() {
  [[ -n "$RDS_INTRANET" ]] || { add intranet SKIP "RDS_INTRANET not set (intranet hostname unknown)"; return; }
  command -v nc >/dev/null 2>&1 || { add intranet SKIP "nc not installed"; return; }
  local tag=""; [[ "$USE_SSH" -eq 0 ]] && tag=" [public DNS — meaningful only with --ssh]"
  if run_raw bash -c "nc -z -w 3 '$RDS_INTRANET' '$RDS_PORT'" 2>/dev/null; then
    add intranet OK "$RDS_INTRANET:$RDS_PORT accepts TCP$tag"
  else
    add intranet FAIL "$RDS_INTRANET:$RDS_PORT refuses TCP$tag"
  fi
}

# ─── run all checks + emit ─────────────────────────────────────────────
swas_meta; rds_meta; vpc_peering_check
ping_public; nc_public; curl_egress_ip; route_table; mtu_check
intranet_check

if [[ "$JSON_MODE" -eq 1 ]]; then
  buf=""; for r in "${RESULTS[@]}"; do buf+="$r"$'\n'; done
  DIAG_RESULTS="$buf" DIAG_TS="$(date +%s)" \
    SWAS_INSTANCE_ID="$SWAS_INSTANCE_ID" SWAS_REGION="$SWAS_REGION" \
    RDS_HOST="$RDS_HOST" RDS_PUBLIC="$RDS_PUBLIC" RDS_INTRANET="$RDS_INTRANET" \
    RDS_REGION="$RDS_REGION" RDS_PORT="$RDS_PORT" USE_SSH="$USE_SSH" \
    S_OK="$S_OK" S_FAIL="$S_FAIL" S_SKIP="$S_SKIP" py_emit
else
  printf '\n[diagnose] SWAS=%s (%s) → RDS=%s:%s\n' "$SWAS_INSTANCE_ID" "$SWAS_REGION" "$RDS_HOST" "$RDS_PORT"
  for r in "${RESULTS[@]}"; do IFS='|' read -r n s d <<< "$r"; printf '  [%s] %s: %s\n' "$s" "$n" "$d"; done
  printf '\n[diagnose] summary: %d OK, %d FAIL, %d SKIP\n' "$S_OK" "$S_FAIL" "$S_SKIP"
fi
[[ "$S_FAIL" -gt 0 ]] && exit 1 || exit 0

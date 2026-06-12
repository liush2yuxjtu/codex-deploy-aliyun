#!/bin/bash
# setup_oss_bucket.sh — create the codex-deploy-aliyun-pdf-out bucket in
# cn-shanghai with private ACL. Idempotent. Run on any host with the
# `aliyun` CLI configured (aliyun-start skill provides the AK pair).
#
# Why this exists (ISSUE-022):
#   /pdf handlers in server.js upload generated PDFs to OSS and return a
#   presigned GET URL. Without the bucket, every PDF streams 1MB+ through
#   the SWAS egress, which is what we're trying to avoid.
#
# Usage:
#   bash scripts/setup_oss_bucket.sh             # apply
#   bash scripts/setup_oss_bucket.sh --dry-run   # print the diff, no changes
#
# Prereqs:
#   - `aliyun` CLI on PATH (version >= 3.0; the aliyun-start skill installs it)
#   - AK pair in ~/.claude/skills/aliyun-start/.env (loaded by `set -a; . …`)
#   - `oss:CreateBucket` + `oss:PutBucketAcl` on the active RAM user
#
# The script will NOT:
#   - Delete an existing bucket
#   - Open the bucket to public read
#   - Create a lifecycle policy (cheap, but adds a coupling we'll skip)
#
# After running, add to /etc/codex-api/secret.env on the SWAS:
#   OSS_BUCKET=codex-deploy-aliyun-pdf-out
#   OSS_REGION=cn-shanghai
#   OSS_ACCESS_KEY_ID=...
#   OSS_ACCESS_KEY_SECRET=...
#   OSS_PRESIGN_TTL_SEC=3600
# then `systemctl restart codex-api.service` and `curl /healthz` to see the
# new `oss: { bucket, region, presignTtlSec }` field.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Load creds the same way scripts/install_pdf_skill_for_codex.sh's siblings
# do. We do NOT export them if --dry-run is just printing the plan.
BUCKET="${OSS_BUCKET:-codex-deploy-aliyun-pdf-out}"
REGION="${OSS_REGION:-cn-shanghai}"
ACL="private"
STORAGE_CLASS="${OSS_STORAGE_CLASS:-Standard}"

if [ -f "$HOME/.claude/skills/aliyun-start/.env" ]; then
  set -a; . "$HOME/.claude/skills/aliyun-start/.env"; set +a
fi

if ! command -v aliyun >/dev/null 2>&1; then
  echo "[setup_oss_bucket] aliyun CLI not on PATH; install via aliyun-start skill" >&2
  exit 1
fi

log() { echo "[setup_oss_bucket] $*"; }

log "target bucket : $BUCKET"
log "region        : $REGION"
log "acl           : $ACL"
log "storage class : $STORAGE_CLASS"
log "dry-run       : $DRY_RUN"

probe() {
  # ossutil-style API call. aliyun oss ls works on every CLI version; we
  # use the bucket's `ls` to test for existence before trying to create.
  aliyun oss ls "oss://${BUCKET}/" --region "$REGION" >/dev/null 2>&1
}

run_or_print() {
  # $1 = description, rest = command
  local desc="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [DRY-RUN] %s\n    $ %s\n' "$desc" "$*"
  else
    log "$desc"
    "$@"
  fi
}

# ─── 1. probe ───
log "step 1/4 — probe bucket"
if probe; then
  log "  bucket already exists — skipping create"
  BUCKET_EXISTS=1
else
  BUCKET_EXISTS=0
  log "  bucket does not exist — will create"
fi

# ─── 2. create bucket (private) ───
log "step 2/4 — create bucket (if needed)"
if [ "$BUCKET_EXISTS" -eq 0 ]; then
  # aliyun oss mb syntax: aliyun oss mb oss://<bucket> --region <r> [--acl <acl>]
  run_or_print "create bucket" \
    aliyun oss mb "oss://${BUCKET}" --region "$REGION" --acl "$ACL"
else
  log "  (skipped) bucket already present"
fi

# ─── 3. enforce private ACL (idempotent) ───
log "step 3/4 — enforce ACL=private (idempotent)"
run_or_print "set bucket ACL to private" \
  aliyun oss update-acl "oss://${BUCKET}" --acl "$ACL" --region "$REGION"

# ─── 4. cross-check ───
log "step 4/4 — cross-check"
if [ "$DRY_RUN" -eq 0 ]; then
  if probe; then
    log "  ✓ bucket reachable"
  else
    log "  ✗ bucket NOT reachable after setup" >&2
    exit 3
  fi
  ACL_NOW=$(aliyun oss get-acl "oss://${BUCKET}" --region "$REGION" 2>/dev/null | tr -d '\r' | awk -F': *' '/ACL:/{print $2; exit}')
  if [ "$ACL_NOW" = "$ACL" ]; then
    log "  ✓ ACL is $ACL"
  else
    log "  ✗ ACL is '$ACL_NOW', expected '$ACL'" >&2
    exit 4
  fi
else
  log "  [DRY-RUN] would have probed + read ACL here"
fi

cat <<EOF

=== DONE ===
Bucket: $BUCKET
Region: $REGION
ACL:    $ACL

Next steps on SWAS (root@106.14.154.23):
  1. Append to /etc/codex-api/secret.env:
       OSS_BUCKET=$BUCKET
       OSS_REGION=$REGION
       OSS_ACCESS_KEY_ID=<your AK>
       OSS_ACCESS_KEY_SECRET=<your AS>
       OSS_PRESIGN_TTL_SEC=3600
  2. systemctl restart codex-api.service
  3. curl -s http://127.0.0.1:3030/healthz | jq .oss
     (should show { bucket, region, presignTtlSec })

The RAM policy for the codexsbx user only needs:
  - oss:PutObject on acs:oss:*:$BUCKET/pdfs/*
  - oss:GetObject on acs:oss:*:$BUCKET/pdfs/*  (only for re-presign / verify)
Public read is intentionally NOT granted.
EOF

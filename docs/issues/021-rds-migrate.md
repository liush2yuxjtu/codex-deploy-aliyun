---
id: ISSUE-021
us: v3-#1
title: rds-migrate.sh — idempotent migration applier
parallel_group: v3A
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/rds-migrate.sh
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: done
merged_commit: 6d932d1
closed_at: 2026-06-12
---

# ISSUE-021: rds-migrate.sh — idempotent migration applier

## What to build

Wraps `psql` + (optionally) SSH so applying `migrations/*.sql` is one command. Backed by a `_migrations` ledger table — re-runs are a no-op.

## Acceptance criteria (all met)

- [x] `--status`: list applied vs pending
- [x] `--dry-run`: print what would run
- [x] `--ssh`: run against the SWAS-hosted RDS via SSH key (the path that works for the cn-hangzhou free-trial instance)
- [x] `--target NNN`: stop after `NNN.sql`
- [x] `_migrations` ledger: records `(name, applied_at, md5)`; second run is a no-op
- [x] Replaces manual `ssh + psql -f migrations/...` loop used during v2 010/014 deploys

## Blocked by

None

## Notes

- Implemented: `scripts/rds-migrate.sh` (154 lines, `bash -n` clean)
- Used by: ISSUE-025 (`ecs-code-deploy.sh`) as the migration step
- Open follow-up: existing `codex_jobs` and `codex_runs` schema rows from v2 010/014 deploys are NOT in the ledger yet — backfill via one-off `INSERT INTO _migrations(name, md5)` from psql if you want ledger to start clean

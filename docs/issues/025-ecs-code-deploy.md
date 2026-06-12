---
id: ISSUE-025
us: v3-#5
title: ecs-code-deploy.sh — idempotent atomic deploy
parallel_group: v3A
type: AFK
blocked_by: []
soft_blocked_by:
  - ISSUE-021
files:
  - scripts/ecs-code-deploy.sh
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: done
merged_commit: ae4401b
closed_at: 2026-06-12
---

# ISSUE-025: ecs-code-deploy.sh — idempotent atomic deploy

## What to build

One-command deploy for the codex-api service on SWAS. Replaces the manual scp + systemctl + psql loop we ran during the v2 e2e sweep.

## Acceptance criteria (all met)

- [x] `node -c` validates local server.js before deploy
- [x] Preflight `systemctl is-active` on the SWAS host
- [x] Backup existing `/opt/codex-api/server.js` → `server.js.bak.<ts>`
- [x] scp local `server.js` + `migrations/*.sql` to SWAS
- [x] Delegate migration to `scripts/rds-migrate.sh --ssh` (ISSUE-021)
- [x] `systemctl restart codex-api.service`
- [x] `curl /healthz` verify (`ok:true`, `db.ok:true`); fail → auto-rollback
- [x] Append deploy line to `/opt/codex-api/deploy.log`
- [x] `--server-only` / `--migrations-only` / `--dry-run` / `--rollback` flags

## Blocked by

None (soft: ISSUE-021 ships the migrate step)

## Notes

- Implemented: `scripts/ecs-code-deploy.sh` (141 lines, `bash -n` clean)
- Replaces (in spirit): `scripts/final_deploy.sh` + `scripts/step_a-*.sh` through `scripts/step_f-*.sh`. The old step files are NOT deleted in this commit — older docs reference them; will be removed in a follow-up after the handoff doc lists `ecs-code-deploy.sh` as the canonical path
- Idempotent: running twice with no local changes is a no-op (server.js identical → systemd may no-op restart; healthz still verified; migrations idempotent via `_migrations` ledger)
- Dependencies: relies on `rds-migrate.sh` (ISSUE-021, commit `6d932d1`) for the migrate step

# Project-level Claude rules

Applies to any session working in this repo. Overrides nothing globally; only
adds project-level discipline.

## Git workflow

### 1. Atomic commits, always

Every file edit, addition, or deletion in this repo must land in its own
commit. No batching of unrelated changes, no "WIP" squashes at the end of a
session.

- One logical change = one commit.
- The commit subject line states *what changed and why* in one short line
  (imperative mood, ≤ 72 chars). Body explains reasoning only when non-obvious.
- If a single edit touches more than one concern (e.g. a refactor + a feature),
  split it into two commits before moving on.
- Pre-commit sanity: `git status` and `git diff --stat` should match the
  intent of the commit subject, and nothing else.

### 2. Push immediately after every commit

The moment a commit is created — feature complete, fix verified, refactor
green — push it to the remote. No accumulating commits locally, no "I'll push
at the end of the day" piles.

- `git push` (or `git push -u origin <branch>` on first push of a new branch)
  runs in the same turn as the commit that produced it.
- If push fails (no remote, auth, network), surface the failure in the chat
  immediately and treat it as blocking — do not start the next edit.
- CI / preview deploys that depend on the remote should see every commit, not
  just the last one of the session.

## Current state (2026-06-11)

- Repo has no commits on `main` and **no git remote configured** — rule #2
  cannot be exercised yet. Add a remote (e.g. `git remote add origin …`) and
  run the initial `git push -u origin main` before the first real edit.
- Working files currently untracked: `frontend/`, `scripts/`, `server/`,
  `CLAUDE.md`.

## Conscious risk acceptance

These risks are known and **will not be fixed** in this project. Do not
spend session time investigating, fixing, or proposing mitigations
unless the user reopens the decision.

### RDS public endpoint exposure (Aliyun yundun SMS alert)

- **Risk**: RDS PostgreSQL (`codex-demo-pgm-…pg.rds.aliyuncs.com`,
  cn-hangzhou) is reachable from the public internet. Aliyun's yundun
  security monitor sends periodic SMS / console alerts about this.
- **Decision**: **Ignored by user direction (2026-06-12).** We will not
  release the public connection, recreate the instance in cn-shanghai,
  or otherwise change the network posture. The `/history` endpoint
  depends on the public endpoint, so any of those mitigations would
  break the demo.
- **What to do when the alert fires**: nothing. Do not propose
  remediation, do not add migrations, do not write runbooks for
  "rotate RDS to VPC intranet". If the user reopens the decision, see
  the `project-rds-security-alert` memory file for the original A/B/C
  options and the trade-off table.

### Credential rotation (LLM OAuth token, RDS password, AccessKey, SSH key)

- **Risk**: The LLM OAuth token, RDS password, Aliyun AccessKey, and
  SSH private key have all been referenced by path (in chat, in handoff
  docs, in memory files) over the lifetime of this project. The values
  were never pasted into chat, but the path-and-metadata exposure
  pattern is the kind of thing a security review would flag.
- **Decision**: **Not rotated, accepted as-is by user direction
  (2026-06-12).** The user judges the current credentials to be safe
  to keep using. The rotation script (`scripts/rotate_credentials.sh`,
  ships with `--dry-run` as default) remains in the repo as a
  reference and as a tool the user can invoke later if they change
  their mind.
- **What to do when this comes up**: do not propose running the
  rotation script, do not nag about the path-and-metadata exposure,
  do not write reminders. If the user reopens the decision, the
  prerequisite is filling `LLM_OAUTH_REFRESH_URL` and
  `LLM_OAUTH_REFRESH_TOKEN` in `~/.claude/skills/aliyun-start/.env`
  (currently placeholder) before `--only llm --apply` can succeed.

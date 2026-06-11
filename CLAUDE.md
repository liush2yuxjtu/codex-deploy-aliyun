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

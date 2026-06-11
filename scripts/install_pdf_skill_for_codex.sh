#!/bin/bash
# install_pdf_skill_for_codex.sh — make md-to-pdf-webfirst visible to the
# sandboxed `codexsbx` user so that `codex exec` can discover the skill
# via its built-in `~/.codex/skills/<name>` walk.
#
# The trap: the SWAS root's home is `dr-xr-x--- root root`, so a symlink
# from `/home/codexsbx/.codex/skills/...` to `/root/.codex/skills/...`
# resolves but cannot be read by codexsbx (Permission denied on
# `cat SKILL.md`). The skill loader silently fails and the model never
# sees it.
#
# Workaround: park the skill under `/opt/codex-skills/` (world-traversable)
# and symlink from there into the codexsbx skills dir. Idempotent — re-runs
# are a no-op once the symlink resolves and the frontmatter parses.
#
# Run on the SWAS as root:
#   bash scripts/install_pdf_skill_for_codex.sh

set -e

SKILL_NAME="md-to-pdf-webfirst"
SKILL_REPO="https://github.com/liush2yuxjtu/md-to-pdf-webfirst-skill"
INSTALL_ROOT="/opt/codex-skills"
CODEXSBX_SKILLS_DIR="/home/codexsbx/.codex/skills"
CODEXSBX_USER="codexsbx"
TARGET="${INSTALL_ROOT}/${SKILL_NAME}"
LINK="${CODEXSBX_SKILLS_DIR}/${SKILL_NAME}"

echo "=== 1. ensure install root + codexsbx skills dir exist ==="
mkdir -p "$INSTALL_ROOT"
mkdir -p "$CODEXSBX_SKILLS_DIR"
chown -R "$CODEXSBX_USER:$CODEXSBX_USER" "$CODEXSBX_SKILLS_DIR"
chmod 700 "$CODEXSBX_SKILLS_DIR"

echo "=== 2. fetch skill (clone or update) ==="
if [ -d "$TARGET/.git" ]; then
  echo "  already cloned — pulling"
  (cd "$TARGET" && git pull --depth 1 --ff-only 2>&1 | tail -3) || true
else
  rm -rf "$TARGET"
  git clone --depth 1 "$SKILL_REPO" "$TARGET"
fi

echo "=== 3. make world-traversable (key fix) ==="
chmod -R a+rX "$INSTALL_ROOT"

echo "=== 4. wire symlink from codexsbx skills dir ==="
# remove a dead link if it points at the old /root path
if [ -L "$LINK" ] && readlink "$LINK" | grep -q "^/root/"; then
  rm -f "$LINK"
fi
ln -sfn "$TARGET" "$LINK"
chown -h "$CODEXSBX_USER:$CODEXSBX_USER" "$LINK"

echo "=== 5. verify codexsbx can actually read SKILL.md ==="
if sudo -u "$CODEXSBX_USER" cat "$LINK/SKILL.md" | head -3; then
  echo "  ✓ codexsbx can read the skill"
else
  echo "  ✗ STILL BLOCKED — check $INSTALL_ROOT perms"
  exit 1
fi

echo ""
echo "=== DONE ==="
echo "Skill location : $TARGET"
echo "Codexsbx link  : $LINK -> $TARGET"
echo "Quick test     : sudo -u $CODEXSBX_USER $CODEXSBX_HOME codex exec \"list available skills\""

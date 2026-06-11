#!/bin/bash
# install_cjk_font.sh — install WenQuanYi Micro Hei on the SWAS so that
# headless Chromium (used by the md-to-pdf-webfirst skill) can render CJK
# characters. Without this, every Chinese glyph in the source HTML collapses
# to a tofu box (□) in the output PDF.
#
# Idempotent: skips if a CJK font is already detected via fc-list :lang=zh.
# Source: SourceForge (https://sourceforge.net/projects/wqy/) — Alibaba Cloud
# Linux 3 base repos don't ship wqy / noto-cjk packages, so we drop the
# TTC directly into /usr/share/fonts/cjk and refresh fontconfig.

set -e

if fc-list :lang=zh 2>/dev/null | grep -qi .; then
  echo "=== CJK font already installed — nothing to do ==="
  fc-list :lang=zh | head -3
  exit 0
fi

echo "=== downloading wqy-microhei (2.4 MB) from SourceForge ==="
TMP=$(mktemp -d)
cd "$TMP"
curl -sSL --max-time 180 -o wqy-microhei.tar.gz \
  "https://master.dl.sourceforge.net/project/wqy/wqy-microhei/0.2.0-beta/wqy-microhei-0.2.0-beta.tar.gz"
test -s wqy-microhei.tar.gz

echo "=== extracting + installing ==="
tar -xzf wqy-microhei.tar.gz
mkdir -p /usr/share/fonts/cjk
cp wqy-microhei/wqy-microhei.ttc /usr/share/fonts/cjk/
chmod 644 /usr/share/fonts/cjk/wqy-microhei.ttc

echo "=== refreshing fontconfig ==="
fc-cache -fv /usr/share/fonts/cjk 2>&1 | tail -2

echo ""
echo "=== verify ==="
fc-list :lang=zh | head -3
rm -rf "$TMP"
echo "=== DONE — re-run any /pdf job to see Chinese in the output ==="

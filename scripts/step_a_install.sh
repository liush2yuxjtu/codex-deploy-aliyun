#!/bin/bash
# Step A: install @openai/codex globally on host + build Docker sandbox image
set -e

echo "=== 1. configure npm mirror (npmmirror.com) ==="
npm config set registry https://registry.npmmirror.com
npm config get registry

echo ""
echo "=== 2. install @openai/codex globally on host ==="
npm i -g @openai/codex 2>&1 | tail -10
which codex && codex --version || codex --help 2>&1 | head -10

echo ""
echo "=== 3. pull node:22-slim for sandbox base ==="
docker pull node:22-slim 2>&1 | tail -3

echo ""
echo "=== 4. write Dockerfile for codex sandbox ==="
mkdir -p /opt/codex-api/sandbox
cat > /opt/codex-api/sandbox/Dockerfile <<'DOCKERFILE'
FROM node:22-slim

# install codex CLI from npm mirror, then drop privileges
RUN npm config set registry https://registry.npmmirror.com \
 && npm install -g @openai/codex \
 && useradd -m -u 1000 codex \
 && mkdir -p /work \
 && chown codex:codex /work

USER codex
WORKDIR /work
ENV TERM=dumb
ENTRYPOINT ["codex"]
DOCKERFILE

echo ""
echo "=== 5. build codex-sandbox:latest image ==="
cd /opt/codex-api/sandbox
docker build -t codex-sandbox:latest . 2>&1 | tail -20

echo ""
echo "=== 6. verify image ==="
docker images codex-sandbox

echo ""
echo "=== 7. smoke test sandbox (no api key — expect help text or auth error) ==="
docker run --rm codex-sandbox:latest --help 2>&1 | head -30 || echo "(expected: help printed)"

echo ""
echo "=== DONE step A ==="

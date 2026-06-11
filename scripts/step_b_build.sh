#!/bin/bash
set -e

CODEX_BIN=/opt/node-v20.18.1-linux-x64/bin/codex

echo "=== 1. test host codex --help (full path) ==="
"$CODEX_BIN" --help 2>&1 | head -40 || echo "(codex --help failed)"

echo ""
echo "=== 2. test 'codex exec --help' (the verb we'll use) ==="
"$CODEX_BIN" exec --help 2>&1 | head -50 || echo "(codex exec --help failed)"

echo ""
echo "=== 3. rewrite Dockerfile (UID 1001 fix + dumb-init for proper signal handling) ==="
mkdir -p /opt/codex-api/sandbox
cat > /opt/codex-api/sandbox/Dockerfile <<'DOCKERFILE'
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && npm config set registry https://registry.npmmirror.com \
 && npm install -g @openai/codex \
 && useradd -m -u 1001 codexsbx \
 && mkdir -p /work \
 && chown codexsbx:codexsbx /work

USER codexsbx
WORKDIR /work
ENV TERM=dumb \
    NODE_OPTIONS="" \
    HOME=/home/codexsbx
ENTRYPOINT ["dumb-init","--","codex"]
DOCKERFILE

echo ""
echo "=== 4. build codex-sandbox:latest (this takes ~60-120s) ==="
cd /opt/codex-api/sandbox
docker build -t codex-sandbox:latest . 2>&1 | tail -15

echo ""
echo "=== 5. verify image ==="
docker images codex-sandbox

echo ""
echo "=== 6. smoke test: codex --help inside sandbox ==="
docker run --rm codex-sandbox:latest --help 2>&1 | head -20

echo ""
echo "=== 7. smoke test: codex exec --help inside sandbox ==="
docker run --rm codex-sandbox:latest exec --help 2>&1 | head -30

echo ""
echo "=== 8. quick run without API key (expect auth error — proves binary reaches the network step) ==="
docker run --rm \
  -e OPENAI_API_KEY="sk-test-INVALID-DEMO-KEY" \
  codex-sandbox:latest exec --yolo --skip-git-repo-check "say hi" 2>&1 | head -30 || echo "(expected — no real key)"

echo ""
echo "=== DONE step B ==="

#!/bin/bash
# No set -e — we want all probes to run
echo "=== check if image was built despite our timeout ==="
docker images codex-sandbox 2>&1

echo ""
echo "=== full 'codex exec --help' (find --yolo, --skip-git-repo-check) ==="
/opt/node-v20.18.1-linux-x64/bin/codex exec --help 2>&1

echo ""
echo "=== check for in-progress docker builds ==="
docker ps -a 2>&1 | head -10
docker builder prune -f --filter until=1h 2>&1 | tail -3

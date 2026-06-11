#!/bin/bash
# Removed set -e — we want to see all probe results even if some fail
echo "=== npm config ==="
npm config get prefix
npm config get registry
npm root -g

echo ""
echo "=== global packages ==="
npm ls -g --depth=0 2>&1 | head -30

echo ""
echo "=== look for codex in common locations ==="
find / -name "codex*" -type f 2>/dev/null | grep -v /proc | head -20

echo ""
echo "=== retry install verbosely ==="
npm install -g @openai/codex --verbose 2>&1 | tail -40

echo ""
echo "=== after retry: what's in prefix/bin ==="
PREFIX=$(npm config get prefix)
ls -la "$PREFIX/bin/" 2>&1 | head -30

echo ""
echo "=== look at the package itself ==="
ROOT=$(npm root -g)
echo "global root: $ROOT"
ls -la "$ROOT/@openai/" 2>&1
ls -la "$ROOT/@openai/codex/" 2>&1 | head -20

echo ""
echo "=== package.json bin entries ==="
cat "$ROOT/@openai/codex/package.json" 2>/dev/null | python3 -c "import json,sys; p=json.load(sys.stdin); print('name:',p.get('name')); print('version:',p.get('version')); print('bin:',p.get('bin')); print('main:',p.get('main')); print('files:',p.get('files'))" 2>&1

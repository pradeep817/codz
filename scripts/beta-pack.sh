#!/usr/bin/env bash
# Makes the beta package: runs the tests and the typecheck, compiles dist/ (so
# testers on Node 20 can run it), packs <package>-<version>.tgz into ./release and
# checks that the packed copy installs and runs in a clean folder.
# Usage: npm run beta:pack
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "• Tests"; npm test --silent >/dev/null
echo "• Typecheck"; npx tsc --noEmit -p tsconfig.json
echo "• Build dist/"; rm -rf dist; npx tsc -p tsconfig.build.json
mkdir -p release
PKG="$(node -p "require('$ROOT/package.json').name")"
TGZ="$(npm pack --pack-destination release 2>/dev/null | tail -n 1)"
echo "• Packed release/$TGZ"
TMP="$(mktemp -d)"
(cd "$TMP" && npm init -y >/dev/null && npm install --no-audit --no-fund "$ROOT/release/$TGZ" >/dev/null)
CODZ="$TMP/node_modules/.bin/codz"
cp -R "$ROOT/fixtures/react-vite" "$TMP/app"
(cd "$TMP/app" && CODZ_DIST=1 "$CODZ" feature add products --spec "$TMP/node_modules/$PKG/examples/openapi.yaml" --yes --allow-dirty --no-verify --no-format --no-install --no-color >/dev/null 2>&1)
(cd "$TMP/app" && "$CODZ" undo --no-color >/dev/null)
rm -rf "$TMP" dist
echo "✓ release/$TGZ installs and runs (feature add + undo on a sample app)."
echo "  Testers install it with: npm install -g ./$TGZ"

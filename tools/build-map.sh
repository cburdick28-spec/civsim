#!/usr/bin/env bash
# Rebuild the static map assets (nothing here runs on Vercel):
#   public/map.bundle.js  <- src/maps.js (+ the parts of three.js it uses)
#   public/earth.json     <- Natural Earth country shapes (world-atlas)
# Needs Node 18+. Re-run after editing src/*.js.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && npm init -y >/dev/null && npm install three esbuild world-atlas topojson-client >/dev/null)
export NODE_PATH="$WORK/node_modules"
"$WORK/node_modules/.bin/esbuild" "$ROOT/src/maps.js" \
  --bundle --minify --format=esm --target=es2020 --legal-comments=none \
  --outfile="$ROOT/public/map.bundle.js"
node "$ROOT/tools/build-earth.cjs"
echo "built public/map.bundle.js ($(wc -c < "$ROOT/public/map.bundle.js") bytes)"

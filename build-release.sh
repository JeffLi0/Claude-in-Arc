#!/usr/bin/env bash
# Packages the patched extension into a ZIP for a GitHub Release.
# Unzipping yields a single folder to point "Load unpacked" at.
set -euo pipefail

SRC="1.0.91_1"
VERSION="$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version_name'])")"
OUT="Claude-in-Arc-${VERSION}.zip"

rm -f "$OUT"
zip -qr "$OUT" "$SRC" \
  -x "$SRC/_metadata/*" \
  -x "*/.DS_Store" \
  -x ".DS_Store"

echo "Built $OUT ($(du -h "$OUT" | cut -f1)) from $SRC"

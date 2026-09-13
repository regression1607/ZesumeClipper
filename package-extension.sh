#!/bin/bash
# package-extension.sh — Creates a clean ZIP for Chrome Web Store submission

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

EXTENSION_NAME="ZesumeClipper"
VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="${DIR}/${EXTENSION_NAME}-v${VERSION}.zip"

# Remove old package
rm -f "$OUTPUT"

# Create ZIP excluding dev, git, and documentation files
zip -r "$OUTPUT" . \
  -x ".git/*" \
  -x ".git" \
  -x "node_modules/*" \
  -x "node_modules" \
  -x ".env" \
  -x "*.map" \
  -x "*.sh" \
  -x "CHROMEWEBSTORE.md" \
  -x "README.md" \
  -x ".DS_Store" \
  -x "Thumbs.db" \
  -x "icons/build-icons.cjs" \
  -x "icons/generate-icons.html"

echo "✅ Packaged successfully: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"


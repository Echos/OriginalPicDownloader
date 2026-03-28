#!/bin/bash
# Chrome Web Store 提出用 zip を作成するスクリプト
set -e

VERSION=$(grep '"version"' manifest.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
ZIP_NAME="OriginalPicDownloader_v${VERSION}.zip"

# 既存 zip を削除
rm -f "$ZIP_NAME"

zip -r "$ZIP_NAME" . \
  --exclude ".git/*" \
  --exclude ".claude/*" \
  --exclude "images/*" \
  --exclude "docs/*" \
  --exclude "build.sh" \
  --exclude ".gitignore" \
  --exclude "*.zip"

echo "Created : $ZIP_NAME"
echo "Size    : $(du -h "$ZIP_NAME" | cut -f1)"
echo ""
echo "Contents:"
unzip -l "$ZIP_NAME"

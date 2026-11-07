#!/bin/bash
# Chrome Web Store 提出用 zip を作成するスクリプト
set -e

VERSION=$(grep '"version"' manifest.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
ZIP_NAME="OriginalPicDownloader_v${VERSION}.zip"

# Windows では python3 コマンドが存在しないことがある
PYTHON=$(command -v python3 || command -v python || true)

# 既存 zip を削除
rm -f "$ZIP_NAME"

if command -v zip >/dev/null 2>&1; then
  zip -r "$ZIP_NAME" . \
    --exclude ".git/*" \
    --exclude ".agents/*" \
    --exclude ".claude/*" \
    --exclude ".codex/*" \
    --exclude "images/*" \
    --exclude "docs/*" \
    --exclude "build.sh" \
    --exclude ".gitignore" \
    --exclude "*.zip"
else
  "$PYTHON" - "$ZIP_NAME" <<'PY'
import os
import sys
import zipfile

zip_name = sys.argv[1]
excluded_dirs = {'.git', '.agents', '.claude', '.codex', 'images', 'docs'}
excluded_files = {'build.sh', '.gitignore'}

with zipfile.ZipFile(zip_name, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for filename in files:
            if filename in excluded_files or filename.endswith('.zip'):
                continue
            path = os.path.join(root, filename)
            arcname = path[2:] if path.startswith('./') else path
            zf.write(path, arcname)
PY
fi

echo "Created : $ZIP_NAME"
echo "Size    : $(du -h "$ZIP_NAME" | cut -f1)"
echo ""
echo "Contents:"
if command -v unzip >/dev/null 2>&1; then
  unzip -l "$ZIP_NAME"
else
  "$PYTHON" - "$ZIP_NAME" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as zf:
    for info in zf.infolist():
        print(f'{info.file_size:8d}  {info.filename}')
PY
fi

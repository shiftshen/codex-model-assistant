#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
APP="$ROOT/build/Codex 模型助手.app"
RELEASE="$ROOT/release"
[[ -x "$APP/Contents/Resources/node" ]] || { echo "Run fetch-runtime.sh and build-app.sh first" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
mkdir -p "$RELEASE"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Codex 模型助手.app"
ln -s /Applications "$STAGING/Applications"
cp "$ROOT/docs/USER-GUIDE.md" "$STAGING/使用说明.md"
ARCH="$(uname -m)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
IMAGE="$RELEASE/Codex-Model-Assistant-$VERSION-$ARCH.dmg"
hdiutil create -quiet -volname "Codex 模型助手 $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$IMAGE"
shasum -a 256 "$IMAGE" > "$RELEASE/SHA256SUMS.txt"
echo "$IMAGE"

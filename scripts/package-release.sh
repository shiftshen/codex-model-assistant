#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
APP="$ROOT/build/Codex 模型助手.app"
RELEASE="$ROOT/release"
[[ -x "$APP/Contents/Resources/node" || -x "$APP/Contents/Resources/node-arm64" ]] || { echo "Run fetch-runtime.sh and build-app.sh first" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
mkdir -p "$RELEASE"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Codex 模型助手.app"
ln -s /Applications "$STAGING/Applications"
cp "$ROOT/docs/USER-GUIDE.md" "$STAGING/使用说明.md"
# 名字跟真实内容走：通用了就写 universal，别再叫 arm64 骗人。
APP_ARCHS="$(lipo -archs "$APP/Contents/MacOS/CodexModelAssistant" 2>/dev/null || echo "$(uname -m)")"
case "$APP_ARCHS" in
  *"x86_64 arm64"*|*"arm64 x86_64"*) ARCH="universal" ;;
  *x86_64*) ARCH="x64" ;;
  *) ARCH="arm64" ;;
esac
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
IMAGE="$RELEASE/Codex-Model-Assistant-$VERSION-$ARCH.dmg"
hdiutil create -quiet -volname "Codex 模型助手 $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$IMAGE"
# 累积写入：以前是 > 覆盖，跑一次就把 2.0.0/2.1.0 的校验值弄丢了。
SUMS="$RELEASE/SHA256SUMS.txt"
NAME="$(basename "$IMAGE")"
DIGEST="$(shasum -a 256 "$IMAGE" | awk '{print $1}')"
if [[ -f "$SUMS" ]]; then
  grep -v "  $NAME\$" "$SUMS" > "$SUMS.tmp" || true
else
  : > "$SUMS.tmp"
fi
printf '%s  %s\n' "$DIGEST" "$NAME" >> "$SUMS.tmp"
sort -k2 "$SUMS.tmp" > "$SUMS"
rm -f "$SUMS.tmp"
echo "$IMAGE"

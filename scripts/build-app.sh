#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
BUILD="$ROOT/build"
APP="$BUILD/Codex 模型助手.app"

mkdir -p "$BUILD" "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime"

if [[ ! -f "$ROOT/Resources/AppIcon.icns" ]]; then
  "$ROOT/scripts/make-icon.sh"
fi

# 构建产物落在仓库的 build/ 里，会被 Spotlight / LaunchServices 一起收录，
# 结果 Launchpad 里出现两个「Codex 模型助手」（一个是 /Applications 里的正主，
# 一个是这里的构建产物）。放一个 .metadata_never_index 并主动注销，别让它再冒出来。
touch "$BUILD/.metadata_never_index"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true

swiftc \
  -parse-as-library \
  -O \
  -framework SwiftUI \
  -framework AppKit \
  "$ROOT"/Sources/*.swift \
  -o "$APP/Contents/MacOS/CodexModelAssistant"

cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
rsync -a --delete "$ROOT"/src/ "$APP/Contents/Resources/runtime/"
ARCH="$(uname -m)"
[[ "$ARCH" == "x86_64" ]] && ARCH="x64"
NODE_ROOT="$ROOT/.runtime-cache/node-v24.20.0-darwin-$ARCH"
if [[ -x "$NODE_ROOT/bin/node" ]]; then
  cp "$NODE_ROOT/bin/node" "$APP/Contents/Resources/node"
  cp "$NODE_ROOT/LICENSE" "$APP/Contents/Resources/Node-LICENSE"
fi
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

chmod 755 "$APP/Contents/MacOS/CodexModelAssistant"
IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)}"
if [[ -n "$IDENTITY" ]]; then
  if [[ -x "$APP/Contents/Resources/node" ]]; then
    codesign --force --options runtime --timestamp --entitlements "$ROOT/Resources/node-entitlements.plist" --sign "$IDENTITY" "$APP/Contents/Resources/node"
  fi
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
echo "$APP"

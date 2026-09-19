#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
BUILD="$ROOT/build"
APP="$BUILD/Model Router.app"
NODE_VERSION="24.20.0"
# 显式指定部署目标：不给 -target 的话 swiftc 会按本机 SDK 写 minos。
# 之前在 macOS 26 的机器上构建，二进制里写的就是「最低要求 26.0」——
# Info.plist 写 14.0 也没用，老系统上根本加载不起来。
DEPLOYMENT_TARGET="12.0"

mkdir -p "$BUILD/slices" "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime"

if [[ ! -f "$ROOT/Resources/ModelRouter.icns" ]]; then
  "$ROOT/scripts/make-icon.sh"
fi

# 构建产物落在仓库的 build/ 里，会被 Spotlight / LaunchServices 一起收录，
# 结果 Launchpad 里出现两个「Model Router」（一个是 /Applications 里的正主，
# 一个是这里的构建产物）。放一个 .metadata_never_index 并主动注销，别让它再冒出来。
touch "$BUILD/.metadata_never_index"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true

# 两个架构各编一份再合并：同一份 dmg 在 Apple Silicon 和 Intel 上都能直接跑。
SLICES=()
for ARCH in arm64 x86_64; do
  OUT="$BUILD/slices/CodexModelAssistant-$ARCH"
  if swiftc \
      -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
      -parse-as-library -O \
      -framework SwiftUI -framework AppKit \
      "$ROOT"/Sources/*.swift -o "$OUT" 2>"$BUILD/slices/$ARCH.log"; then
    SLICES+=("$OUT")
    echo "已编译 $ARCH（最低 macOS $DEPLOYMENT_TARGET）"
  else
    echo "跳过 $ARCH：$(tail -2 "$BUILD/slices/$ARCH.log" | tr '\n' ' ')" >&2
  fi
done
[[ ${#SLICES[@]} -gt 0 ]] || { echo "两个架构都没编译成功，检查 $BUILD/slices/*.log" >&2; exit 1; }
lipo -create -output "$APP/Contents/MacOS/CodexModelAssistant" "${SLICES[@]}"
echo "主程序架构：$(lipo -archs "$APP/Contents/MacOS/CodexModelAssistant")"

cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
rsync -a --delete "$ROOT"/src/ "$APP/Contents/Resources/runtime/"

# 两个架构的 node 都带上，运行时按架构选（见 ModelLibrary 的 bundledNode）。
for ARCH in arm64 x64; do
  NODE_ROOT="$ROOT/.runtime-cache/node-v$NODE_VERSION-darwin-$ARCH"
  if [[ -x "$NODE_ROOT/bin/node" ]]; then
    cp "$NODE_ROOT/bin/node" "$APP/Contents/Resources/node-$ARCH"
    cp "$NODE_ROOT/LICENSE" "$APP/Contents/Resources/Node-LICENSE"
  else
    echo "缺少 $ARCH 的 node 运行时（先跑 scripts/fetch-runtime.sh）" >&2
  fi
done
# 旧路径兼容：以前所有地方都写死 Contents/Resources/node，留一份构建机架构的。
HOST_ARCH="$(uname -m)"; [[ "$HOST_ARCH" == "x86_64" ]] && HOST_ARCH="x64"
if [[ -f "$APP/Contents/Resources/node-$HOST_ARCH" ]]; then
  cp "$APP/Contents/Resources/node-$HOST_ARCH" "$APP/Contents/Resources/node"
fi

cp "$ROOT/Resources/ModelRouter.icns" "$APP/Contents/Resources/ModelRouter.icns"
chmod 755 "$APP/Contents/MacOS/CodexModelAssistant"

IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)}"
NODE_BINS=("$APP/Contents/Resources/node" "$APP/Contents/Resources/node-arm64" "$APP/Contents/Resources/node-x64")
if [[ -n "$IDENTITY" ]]; then
  # node 是独立可执行文件，必须单独签（带自己的 entitlements），否则主程序签了它也起不来。
  for NODE_BIN in "${NODE_BINS[@]}"; do
    [[ -x "$NODE_BIN" ]] || continue
    codesign --force --options runtime --timestamp --entitlements "$ROOT/Resources/node-entitlements.plist" --sign "$IDENTITY" "$NODE_BIN"
  done
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  for NODE_BIN in "${NODE_BINS[@]}"; do
    [[ -x "$NODE_BIN" ]] && codesign --force --sign - "$NODE_BIN"
  done
  codesign --force --deep --sign - "$APP"
fi
echo "$APP"

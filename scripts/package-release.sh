#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
APP="$ROOT/build/Model Router.app"
RELEASE="$ROOT/release"
[[ -x "$APP/Contents/Resources/node" || -x "$APP/Contents/Resources/node-arm64" ]] || { echo "Run fetch-runtime.sh and build-app.sh first" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
mkdir -p "$RELEASE"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Model Router.app"
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
IMAGE="$RELEASE/Model-Router-$VERSION-$ARCH.dmg"
hdiutil create -quiet -volname "Model Router $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$IMAGE"
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

# ---- 公证（Apple notarization）----
# 优先使用显式 NOTARY_PROFILE；未指定时自动尝试本机已验证可用的 profile。
# 安全边界：这里只引用钥匙串 profile 名，不读取/打印任何 Apple 密码、API Key 或私钥。
PROFILE="${NOTARY_PROFILE:-}"
if [[ -z "$PROFILE" ]]; then
  for candidate in xbrowser-notary codex-model-assistant; do
    if xcrun notarytool history --keychain-profile "$candidate" >/dev/null 2>&1; then
      PROFILE="$candidate"
      break
    fi
  done
fi

NOTARIZE_STATE="未公证"
if [[ -n "$PROFILE" ]] && xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "已找到公证凭据（profile: $PROFILE）"

  # 先公证 App。本体不能直接交给 notarytool，用 ditto 保留 bundle 结构打成 zip。
  APP_ZIP="$RELEASE/Model-Router-$VERSION-$ARCH-app.zip"
  rm -f "$APP_ZIP"
  ditto -c -k --keepParent "$APP" "$APP_ZIP"
  echo "提交 App 公证…"
  xcrun notarytool submit "$APP_ZIP" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=4 "$APP"

  # App 已装订票据后重新生成最终 DMG，再单独公证 DMG。
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  ditto "$APP" "$STAGING/Model Router.app"
  ln -s /Applications "$STAGING/Applications"
  cp "$ROOT/docs/USER-GUIDE.md" "$STAGING/使用说明.md"
  hdiutil create -quiet -volname "Model Router $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$IMAGE"

  echo "提交 DMG 公证…"
  xcrun notarytool submit "$IMAGE" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$IMAGE"
  xcrun stapler validate "$IMAGE"
  NOTARIZE_STATE="App + DMG 已公证并装订（$PROFILE）"

  rm -f "$APP_ZIP"
else
  echo "未找到可用的 notarytool keychain profile，这份包不会被公证。"
  echo "后果：别人从网络下载后第一次打开需要右键 → 打开，或先执行"
  echo "      xattr -dr com.apple.quarantine \"/Applications/Model Router.app\""
fi

# 公证后 DMG 内容改变，最终摘要必须在所有 staple 操作之后重新计算。
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
echo "公证状态：$NOTARIZE_STATE"
echo "SHA-256：$DIGEST"

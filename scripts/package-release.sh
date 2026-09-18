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

# ---- 公证（Apple notarization）----
# 「能不能在别人的 Mac 上顺利打开」取决于这一步。没公证的话，从网络下载的包第一次打开会被
# Gatekeeper 拦下（提示「无法验证开发者」/「已损坏」），必须右键 → 打开 才能过。
# 这里做两件事：有凭据就自动提交并装订（staple）；没有就把「缺什么、怎么补」写清楚，
# 免得每次都要重新查一遍。
#
# 需要的凭据（任选一种，都放在钥匙串里）：
#   xcrun notarytool store-credentials "codex-model-assistant" \
#       --apple-id <你的 Apple ID> --team-id PGJ5BY2925 --password <App 专用密码>
# 或者用 App Store Connect API Key：--key AuthKey_XXX.p8 --key-id XXX --issuer <issuer-uuid>
# 指定 profile 名：NOTARY_PROFILE=xxx zsh scripts/package-release.sh
PROFILE="${NOTARY_PROFILE:-codex-model-assistant}"
NOTARIZE_STATE="未公证"
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "已找到公证凭据（profile: $PROFILE），开始提交…"
  if xcrun notarytool submit "$IMAGE" --keychain-profile "$PROFILE" --wait; then
    xcrun stapler staple "$IMAGE"
    xcrun stapler validate "$IMAGE"
    NOTARIZE_STATE="已公证并装订（$PROFILE）"
  else
    echo "公证提交失败，包仍然可用但要靠右键打开；先用 notarytool log 看原因。" >&2
    NOTARIZE_STATE="公证提交失败"
  fi
else
  echo "未找到公证凭据（keychain profile「$PROFILE」），这份包不会被公证。"
  echo "后果：别人从网络下载后第一次打开需要右键 → 打开，或先执行"
  echo "      xattr -dr com.apple.quarantine \"/Applications/Codex 模型助手.app\""
  echo "要做公证，先执行一次："
  echo "  xcrun notarytool store-credentials \"$PROFILE\" --apple-id <Apple ID> --team-id PGJ5BY2925 --password <App 专用密码>"
fi

echo "$IMAGE"
echo "公证状态：$NOTARIZE_STATE"
echo "SHA-256：$DIGEST"

#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
ICONSET="$ROOT/build/ModelRouter.iconset"
MASTER="$ROOT/assets/brand/model-router-app-icon.png"

[[ -f "$MASTER" ]] || { echo "缺少品牌图标：$MASTER" >&2; exit 1; }
rm -rf "$ICONSET"
mkdir -p "$ROOT/Resources" "$ICONSET"

for spec in "16:icon_16x16.png" "32:icon_16x16@2x.png" "32:icon_32x32.png" "64:icon_32x32@2x.png" "128:icon_128x128.png" "256:icon_128x128@2x.png" "256:icon_256x256.png" "512:icon_256x256@2x.png" "512:icon_512x512.png" "1024:icon_512x512@2x.png"; do
  pixels="${spec%%:*}"
  name="${spec#*:}"
  sips -z "$pixels" "$pixels" "$MASTER" --out "$ICONSET/$name" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$ROOT/Resources/ModelRouter.icns"
echo "$ROOT/Resources/ModelRouter.icns"

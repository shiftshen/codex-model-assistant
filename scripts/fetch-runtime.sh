#!/bin/zsh
# 取 Node 运行时。要出「通用二进制」就得两个架构都拿到——
# 只取本机架构的话，在 Intel Mac 上打开这份 dmg 会因为 node 是 arm64 而起不来。
set -euo pipefail
ROOT="${0:A:h:h}"
VERSION="v24.20.0"
CACHE="$ROOT/.runtime-cache"
mkdir -p "$CACHE"
curl -fsSL --max-time 30 "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"

for ARCH in arm64 x64; do
  NAME="node-$VERSION-darwin-$ARCH"
  if [[ -x "$CACHE/$NAME/bin/node" ]]; then
    echo "已缓存 $NAME"
    continue
  fi
  curl -fsSL --max-time 300 "https://nodejs.org/dist/$VERSION/$NAME.tar.gz" -o "$CACHE/$NAME.tar.gz"
  cd "$CACHE"
  awk -v archive="$NAME.tar.gz" '$2 == archive {print}' SHASUMS256.txt > "selected-$ARCH.sha256"
  [[ -s "selected-$ARCH.sha256" ]] || { echo "SHASUMS256.txt 里找不到 $NAME.tar.gz" >&2; exit 1; }
  shasum -a 256 -c "selected-$ARCH.sha256"
  tar -xzf "$NAME.tar.gz"
  "$CACHE/$NAME/bin/node" --version
done

# 兼容旧路径：Contents/Resources/node 仍然保留一份（按本机构建架构），
# 但真正决定用哪个的是 build-app.sh 里按架构命名的 node-arm64 / node-x64。
echo "运行时已就绪：$CACHE"

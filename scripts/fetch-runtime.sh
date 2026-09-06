#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
VERSION="v24.20.0"
ARCH="$(uname -m)"
[[ "$ARCH" == "x86_64" ]] && ARCH="x64"
NAME="node-$VERSION-darwin-$ARCH"
CACHE="$ROOT/.runtime-cache"
mkdir -p "$CACHE"
curl -fsSL --max-time 120 "https://nodejs.org/dist/$VERSION/$NAME.tar.gz" -o "$CACHE/$NAME.tar.gz"
curl -fsSL --max-time 30 "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
cd "$CACHE"
awk -v archive="$NAME.tar.gz" '$2 == archive {print}' SHASUMS256.txt > selected.sha256
[[ -s selected.sha256 ]]
shasum -a 256 -c selected.sha256
tar -xzf "$NAME.tar.gz"
"$CACHE/$NAME/bin/node" --version

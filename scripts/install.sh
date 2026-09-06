#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
APP_SOURCE="$ROOT/build/Codex 模型助手.app"
APP_TARGET="/Applications/Codex 模型助手.app"
RUNTIME="$HOME/.codex/model-assistant/runtime"
CLI_DIR="$HOME/.codex/bin/codex-model-assistant"
PLIST="$HOME/Library/LaunchAgents/local.shift.codex-deepseek-relay.plist"

"$ROOT/scripts/build-app.sh" >/dev/null
mkdir -p "$RUNTIME" "$CLI_DIR" "$HOME/Library/LaunchAgents"
cp "$ROOT/src/deepseek-relay.mjs" "$RUNTIME/"
cp "$ROOT/src/relay-transform.mjs" "$RUNTIME/"
cp "$ROOT/src/codex-route-manager.mjs" "$CLI_DIR/"
cp "$ROOT/src/route-config.mjs" "$CLI_DIR/"
cp "$ROOT/src/route-manager-lib.mjs" "$CLI_DIR/"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.shift.codex-deepseek-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$RUNTIME/deepseek-relay.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/codex-deepseek-relay.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/codex-deepseek-relay.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/local.shift.codex-deepseek-relay" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [[ -d "$APP_TARGET" ]]; then
  mv "$APP_TARGET" "/Applications/Codex 模型助手.app.backup-$(date +%Y%m%d-%H%M%S)"
fi
ditto "$APP_SOURCE" "$APP_TARGET"
codesign --verify --deep --strict "$APP_TARGET"
echo "$APP_TARGET"

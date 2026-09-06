#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
TARGET="/Applications/Codex 模型助手.app"
RUNTIME="$HOME/.codex/model-assistant/runtime-v2"
PLIST="$HOME/Library/LaunchAgents/local.shift.codex-model-gateway.plist"
"$ROOT/scripts/build-app.sh"
mkdir -p "$RUNTIME" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$ROOT"/src/*.mjs "$RUNTIME/"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.shift.codex-model-gateway</string>
<key>ProgramArguments</key><array><string>$TARGET/Contents/Resources/node</string><string>$RUNTIME/model-gateway.mjs</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/codex-model-gateway.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/codex-model-gateway.log</string>
</dict></plist>
PLIST
chmod 600 "$PLIST"
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/local.shift.codex-model-gateway" 2>/dev/null || true
pkill -x CodexModelAssistant 2>/dev/null || true
if [[ -d "$TARGET" ]]; then
  mv "$TARGET" "$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
fi
ditto "$ROOT/build/Codex 模型助手.app" "$TARGET"
codesign --verify --deep --strict "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "$TARGET"

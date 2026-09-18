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

# 刚 ditto 过来的新副本在 LaunchServices 里还是旧记录，Finder 会把它当成普通文件夹。
# 不能用 SetFile -a B：Finder 附加信息会让 codesign 报 detritus 并让签名校验失败。
touch "$TARGET"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET" || true

# 只保留最近 5 份旧版本备份，免得 /Applications 里堆一堆 .backup-* 目录。
ls -1d "$TARGET".backup-* 2>/dev/null | sort | head -n -5 | while IFS= read -r stale; do
  rm -rf "$stale"
done

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "$TARGET"

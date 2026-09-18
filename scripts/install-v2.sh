#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
TARGET="/Applications/Codex 模型助手.app"
RUNTIME="$HOME/.codex/model-assistant/runtime-v2"
PLIST="$HOME/Library/LaunchAgents/local.shift.codex-model-gateway.plist"
"$ROOT/scripts/build-app.sh"
mkdir -p "$RUNTIME" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
# 只覆盖不删除的话，删掉的模块会一直留在运行时目录里——用户以为功能没了，
# 其实旧代码还在磁盘上（还可能被别的进程加载）。用 rsync --delete 做真正的同步。
rsync -a --delete "$ROOT"/src/ "$RUNTIME/"
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
# 旧版本备份放到 ~/.codex/model-assistant/backups 下，不要把 /Applications 堆满 .backup-* 目录。
BACKUPS="$HOME/.codex/model-assistant/backups"
mkdir -p "$BACKUPS"
if [[ -d "$TARGET" ]]; then
  mv "$TARGET" "$BACKUPS/Codex 模型助手-$(date +%Y%m%d-%H%M%S).app"
fi
ditto "$ROOT/build/Codex 模型助手.app" "$TARGET"
codesign --verify --deep --strict "$TARGET"

# 刚 ditto 过来的新副本在 LaunchServices 里还是旧记录，Finder 会把它当成普通文件夹。
# 不能用 SetFile -a B：Finder 附加信息会让 codesign 报 detritus 并让签名校验失败。
touch "$TARGET"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET" || true

# /Applications 里只留一个应用：清掉历史遗留的 .backup-*，备份目录只留最近 2 份。
"$TARGET/Contents/Resources/node" "$ROOT/scripts/prune-app-backups.mjs" "$TARGET" "$BACKUPS" 2

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "$TARGET"

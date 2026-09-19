#!/bin/zsh
# 把仓库里的最新源码同步到运行时目录，并让本机网关用新代码重启。
# 用法：zsh scripts/restart-gateway.sh          正常重启
#      CHECK_ONLY=1 zsh scripts/restart-gateway.sh   只比对版本，不重启
set -euo pipefail
ROOT="${0:A:h:h}"
RUNTIME="$HOME/.codex/model-assistant/runtime-v2"
LABEL="gui/$(id -u)/local.shift.codex-model-gateway"
EXPECTED=$(cd "$ROOT" && node -e "import('./src/model-gateway.mjs').then((module) => process.stdout.write(module.gatewayBuild))")
health() { curl -fsS --max-time 2 http://127.0.0.1:18793/health 2>/dev/null || true; }

CURRENT=$(health)
if [[ "$CURRENT" == *"\"build\":\"$EXPECTED\""* ]]; then
  echo "网关已是最新代码（$EXPECTED）：$CURRENT"
  exit 0
fi
echo "当前网关：${CURRENT:-未运行}"
echo "期望指纹：$EXPECTED"
if [[ "${CHECK_ONLY:-}" == "1" ]]; then
  echo "仅比对模式，未重启。"
  exit 0
fi

mkdir -p "$RUNTIME"
cp "$ROOT"/src/*.mjs "$RUNTIME/"
launchctl kickstart -k "$LABEL"
for _ in {1..60}; do
  sleep 0.25
  CURRENT=$(health)
  if [[ "$CURRENT" == *"\"build\":\"$EXPECTED\""* ]]; then
    echo "网关已重启到新代码：$CURRENT"
    exit 0
  fi
done
echo "网关重启后仍未报告新指纹，请打开「Model Router」或查看 ~/Library/Logs/codex-model-gateway.log" >&2
exit 1

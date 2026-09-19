# Model Router 3.0.0

## 3.0.1 智能一致性修复

- 所有隔离 Codex 窗口共享全局 `AGENTS.md`、skills、plugins、hooks 和 auth。
- 窗口 config 保留全局 reasoning / plan / `[agents]` 设置，只覆盖模型/provider。
- 默认开发推理调整为 Medium；子智能体继续使用 Terra + High。
- 已有隔离环境同步迁移，修复历史 Low reasoning 和缺失 AGENTS 的窗口。

3.0 是 Codex 模型助手的正式品牌升级版本。

## 重点变化

- 产品显示名称改为 **Model Router / 模型路由助手**
- 全新 Logo、App Icon、Hero 和 Brand Guide
- macOS App 改名为 `Model Router.app`
- macOS DMG 改名为 `Model-Router-3.0.0-universal.dmg`
- Windows 产品名统一为 `Model Router`
- GitHub README 和项目资料全面更新
- 官方入口语义升级为 ChatGPT Desktop / Codex 原版入口
- 保持旧 bundle id、数据目录、Gateway label，升级不丢数据
- macOS 正式包执行 Developer ID 签名、App notarization/staple、DMG notarization/staple 和 Gatekeeper 验证

## 保留的核心能力

- 多 provider 模型库
- Responses / Chat / Anthropic 协议转换
- 流式输出与 fallback
- 多窗口
- 对话账本和扣费来源
- 磁盘副本治理
- 自动接口识别
- Windows Preview

## 安装兼容

macOS 安装脚本会识别旧的 `/Applications/Codex 模型助手.app`，将它移入 `~/.codex/model-assistant/backups`，再安装新的 `/Applications/Model Router.app`。

模型、凭据、窗口注册表和会话继续使用原数据目录。

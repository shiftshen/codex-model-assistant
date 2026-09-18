# Codex 模型助手 2.2

原生 macOS 模型管理与 Codex 多开工具。安装应用位于 `/Applications/Codex 模型助手.app`。

## 功能

- Ornith / Qwen 本地主力，付费专家 MCP 能力；按需、仅手动、停用模式，跨进程次数限额、缓存去重、用量账本。

- 新增和编辑模型、修改 API Key、供应商模板、模型自动发现、搜索、归档恢复。
- 官方 ChatGPT 登录独立入口；DeepSeek 使用官方 `https://api.deepseek.com/v1`。
- 13 类供应商/本地服务模板及自定义模板；未配置凭据的条目明确显示待配置。
- 连接检查、真实推理验证、带时间的验证记录；改 Key / 模型 / 地址 / 协议后失效。
- 每个模型条目独立窗口、任务库和模型配置，多开不修改全局默认模型。
- 无密钥 JSON 导入导出、原子配置写入、冲突检查、备份、诊断。
- loopback 网关按实例令牌鉴权；Responses、Chat Completions、Anthropic Messages 三类接口。
- 可切换窗口：一个 Codex 窗口内直接换第三方模型，任务库和对话原地保留；可把官方与各模型窗口的已有会话导入该窗口。
- 侧边栏项目分组随会话一起迁移：桌面端左侧「项目」读的是 `CODEX_HOME/.codex-global-state.json` 而不是 SQLite，导入与修复都会一并补入该文件；同一目录的重复项目按目录去重并改写归属，不会出现两个同名项目。
- 接口自适：自动识别 Responses / Chat / Anthropic 三套接口（真跑一次最小请求判定）、网关遇 404/405 自动换协议并记住、转达供应商错误原因、地址粘贴自动规范化。
- 流式与容灾：Chat / Anthropic 供应商按增量流式输出（首字即时）；可配置「主模型失败改用备用模型」，额度用尽或服务异常时同一次请求内自动切换。

## 开发与安装

```bash
git clone https://github.com/shiftshen/codex-model-assistant.git
cd codex-model-assistant
npm test
zsh scripts/fetch-runtime.sh
zsh scripts/install-v2.sh
zsh scripts/package-release.sh
```

`fetch-runtime.sh` 从 Node.js 官方获取固定版本并校验 SHA-256；新构建内置运行时。`install-v2.sh` 备份旧应用、安装新版本和用户级网关服务。直接打开 App 也会自动启动缺失的网关。旧版 install.sh 和 route-manager 保留用于 1.x 兼容，不用于 2.x 发布。

## 代码结构

- `Sources/`：SwiftUI 模型库、编辑器、进程调用。
- `src/model-store.mjs`：模型库、凭据、并发与输入校验。
- `src/product-service.mjs`：发现、验证、实例准备、启动、诊断。
- `src/session-transfer.mjs`：会话/项目元数据迁移——任务库合并、导入，以及 `.codex-global-state.json` 的侧边栏项目分组合并（只增不改、按目录去重、原子写入并备份）。
- `src/model-gateway.mjs`、`src/protocol-adapter.mjs`：鉴权网关和协议转换。
- `src/provider-templates.mjs`：可维护的供应商目录。
- `tests/product.test.mjs`、`tests/router.test.mjs`、`tests/session-transfer.test.mjs`：产品回归、可切换窗口与项目分组迁移测试。
- `scripts/smoke-live.mjs`：真实 Codex shell 工具往返验收，会消耗对应供应商额度。
- `scripts/smoke-switch-live.mjs`：可切换窗口验收：模型 A 跑 shell 工具往返，再用模型 B 接着同一会话回答。
- `src/expert-*.mjs`、`Sources/ExpertSettingsView.swift`：本地专家服务、预算账本与策略面板。
- `scripts/smoke-expert-live.mjs`：真实本地模型 → 专家 → 本地总结的端到端验收；`simple` 参数验证零付费调用。

详细使用、数据路径、密钥保护与分发条件见 `docs/USER-GUIDE.md`。本次发行是本机验收的签名发布候选，不将未公证或缺少供应商实测的部分宣称为公共商业分发已完成。

## 协议来源

- DeepSeek 官方 Responses：https://api-docs.deepseek.com/guides/responses_api/
- Gemini OpenAI 兼容接口：https://ai.google.dev/gemini-api/docs/openai
- Anthropic API：https://platform.claude.com/docs/en/api/overview
- Ollama 兼容接口：https://docs.ollama.com/api/openai-compatibility

# Codex 模型助手设计

## 目标

提供一个独立的原生 macOS 应用，让用户先选择模型路由，再启动 Codex App。官方 ChatGPT OAuth、DeepSeek、Agnes 与本地 5090 必须按 provider 隔离，不能仅修改模型名。

## 路由

- OpenAI 官方：`openai`，默认 `gpt-6-astra`。
- DeepSeek Flash/Pro：`deepseek-official`，通过本机兼容转接层访问官方 API。
- Agnes：`agnes`，通过现有 `127.0.0.1:18790` 转接层。
- 5090 Qwen/Ornith：`s5090`，通过现有 `127.0.0.1:18791` 转接层。

## 配置策略

模型助手只管理 `~/.codex/config.toml` 的顶层 `model`、`model_provider`、`model_catalog_json` 与一个有明确边界的 provider 配置块。每次切换先在 `~/.codex/model-assistant/backups` 创建备份，再同目录原子替换；严格配置校验失败则恢复原文件。

密钥只从 `~/.openclaw/secrets` 或启动环境读取，不进入项目、日志和状态文件。官方路由不代理 ChatGPT OAuth。

## 界面

单窗口双栏布局：左侧为六个路由选项，右侧显示模型、provider、端点、连接状态和说明。主要操作是“检查连接”“仅应用”“应用并启动 Codex”。状态必须包含检查中、可用、不可用、应用中、成功和失败。

## 启动行为

“应用并启动”先完成健康检查与配置应用，再温和退出已运行的 Codex，最后以所需 provider 环境启动 `/Applications/Codex.app`。如果检查或写入失败，不启动 Codex。

默认启用“独立实例”。每个路由使用独立的 `CODEX_HOME`、Electron `user-data-dir`、任务数据库和窗口状态，只读共享登录凭据、技能与插件。同一路由重复启动聚焦已有实例，不同路由可以同时运行。关闭独立实例后，继续保留原来的全局单实例切换行为。

## 验收

- Node 单元测试覆盖配置切换、幂等、保留无关配置与路由识别。
- Swift App 可编译并通过签名检查。
- 每条路由进行 `/v1/models` 或 app-server 模型列表检查。
- OpenAI、Agnes、DeepSeek 与 5090 至少各完成一次真实 Codex 调用。
- 视觉检查确认无截断、状态明确、按钮具备禁用与加载状态。

# Codex 模型助手 2.3.2

原生 macOS 模型管理与 Codex 多开工具。安装应用位于 `/Applications/Codex 模型助手.app`。

## 功能

- 第三方模型库与官方 ChatGPT 登录：DeepSeek 等走各自的官方接口，官方入口用 ChatGPT OAuth，互不影响。
- 本地模型（Ollama 上的 Ornith / Qwen）降级为**可选供应商**：未通过开发能力验收，已归档，默认不出现，可在「显示归档模型」里查看；重新评估的条件见 `docs/LOCAL-QUALIFICATION.md`。专家策略面板里的本地模型选择保留，只用来自行评估。

- 新增和编辑模型、修改 API Key、供应商模板、模型自动发现、搜索、归档恢复。
- 官方 ChatGPT 登录独立入口；DeepSeek 使用官方 `https://api.deepseek.com/v1`。
- 13 类供应商/本地服务模板及自定义模板；未配置凭据的条目明确显示待配置。
- 连接检查、真实推理验证、带时间的验证记录；改 Key / 模型 / 地址 / 协议后失效。
- 每个模型条目独立窗口、任务库和模型配置，多开不修改全局默认模型。
- 窗口多开：任意数量窗口同时运行，每个窗口自带一份 `CODEX_HOME` 与浏览器数据目录（`--user-data-dir` 与 `CODEX_ELECTRON_USER_DATA_PATH` 同值），互不干扰，也和官方 Codex 的 Electron 状态完全隔离；窗口列表里可以新建、打开、关闭、重命名、删除，界面用 `ps` 真实命令行判定哪个窗口在跑（PID 一并显示）。
- 无密钥 JSON 导入导出、原子配置写入、冲突检查、备份、诊断。
- loopback 网关按实例令牌鉴权；Responses、Chat Completions、Anthropic Messages 三类接口。
- 每个窗口都能换模型：窗口的 `config.toml` 指向网关的 `cma_router` 路由，Codex 顶部的模型选择就是全部可切换条目（官方登录与已归档模型不在其中），对话和任务库原地保留。窗口注册表 `windows.json` 记录名称与起始模型（槽位 `router` 沿用历史路径 `router-v1/`，新窗口放 `windows-v1/<id>/`），需要旧对话时再手动导入。
- 侧边栏项目分组随会话一起迁移：桌面端左侧「项目」读的是 `CODEX_HOME/.codex-global-state.json` 而不是 SQLite，导入与修复都会一并补入该文件；同一目录的重复项目按目录去重并改写归属，不会出现两个同名项目。
- 接口自适：自动识别 Responses / Chat / Anthropic 三套接口（真跑一次最小请求判定）、网关遇 404/405 自动换协议并记住、转达供应商错误原因、地址粘贴自动规范化。
- 流式与容灾：Chat / Anthropic 供应商按增量流式输出（首字即时）；可配置「主模型失败改用备用模型」，额度用尽或服务异常时同一次请求内自动切换。
- 网关指纹只覆盖它真正 import 的模块，且与目录无关（仓库源码与安装副本算出同一个指纹）：改一个网关不加载的文件（如 `src/product-service.mjs`）不再被误判成「必须重启网关」；真的升级不上时沿用仍在服务的旧进程并如实告知，不会把用户挡在门外。
- 新建窗口失败会自动撤销刚写入的注册表条目，重试仍用同一个编号。
- 关窗只关自己：先核对 PID 的命令行确实带该窗口自己的 `--user-data-dir`，再连同该窗口的整个进程组一起结束。多开时不会误伤别的窗口或助手自己，也不会留下占着 `browser-data` 的渲染残留子进程。
- Anthropic 工具 schema 清洗：Anthropic Messages 只接受字符串 `enum`，而 Codex 的工具 schema 里有数字/布尔 `enum`（`request.tools[0].function_declarations[53]`）。直接转发会让整个请求 400 失败，现在会递归去掉无法安全转成字符串的 `enum`/`const`，同时保持 `type` 不变，数字字段不会被悄悄改成字符串字段。
- 新开的窗口会被提到最前（按进程号激活），不会因为开在当前窗口后面而看起来「点了没反应」。
- 建窗不再丢窗口：`windows.json` 是「读-改-写」，之前两次建窗请求同时到达会各自算出同一个 `w2`，后写的覆盖先写的，另一个 Codex 进程就成了注册表里查不到的孤儿——进程在跑、界面上看不见，表现就是「只能开一个」。现在编号在锁内分配（锁文件 + 超时重试 + 陈旧锁自动接管），并发建窗一定拿到 `w2`/`w3`/`w4`，改名和记住起始模型也只改自己那一条，不会覆盖期间新建的窗口。
- 孤儿窗口可一键找回：窗口列表会列出「跑着但没登记」的 Codex 进程，点「接管这些窗口」即补进注册表，之后能正常关闭或重新打开，正在进行的对话不受影响。
- 卡住的操作不会把界面锁死：助手每次调用都有时间上限（默认 180 秒），超时就中止并把按钮放回可用状态，不会一直转圈、按钮全灰。注册表陈旧锁的接管时限（5 秒）也明显短于等待上限（15 秒）——否则持有者异常退出后，锁还没到接管时间就先撞上等待上限，建窗会白报「正被另一个操作占用」。
- 关窗后顺带收掉该窗口遗留的 crashpad 助手进程：它们会被 reparent 到 init，不受进程组信号影响，标记精确到该窗口自己的 `browser-data/Crashpad`，多开反复开关也不会攒下一堆后台进程，也不会误杀别的窗口。
- 窗口列表每个运行中的窗口都有「置前」：被最小化、被压住或丢在其它桌面上的 Codex 一键切到最前，并按屏幕上真实可见的窗口数如实反馈（看不到就直说被最小化，不糊弄）。

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
- `src/window-registry.mjs`：窗口注册表（`windows.json`）——窗口标识校验、槽位路径映射、新建编号与名称分配、原子写入 0600。
- `src/model-gateway.mjs`、`src/protocol-adapter.mjs`：鉴权网关和协议转换。
- `src/provider-templates.mjs`：可维护的供应商目录。
- `tests/product.test.mjs`、`tests/router.test.mjs`、`tests/session-transfer.test.mjs`、`tests/window-registry.test.mjs`、`tests/gateway-build.test.mjs`：产品回归、可切换窗口、项目分组迁移、多窗口与网关指纹测试。
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

# Codex 模型助手

Codex 模型管理与多开工具。macOS 使用原生 SwiftUI；Windows Preview 使用 Electron 壳，两端复用同一套 Node 模型库、路由、网关、会话与磁盘治理核心。

## 当前发布版本

| | |
|---|---|
| 版本 | **2.8.3** |
| 安装包 | `release/Codex-Model-Assistant-2.8.3-universal.dmg`（通用二进制：Apple Silicon + Intel） |
| 系统要求 | macOS 12.0 起 |
| SHA-256 | 见 `release/SHA256SUMS.txt` |
| 签名 | Developer ID Application（Chinda Lorcharoen）；**未做 Apple 公证**，首次打开需右键 → 打开 |

构建与发布：

```bash
zsh scripts/fetch-runtime.sh     # 两个架构的 Node 运行时都要（通用二进制需要）
zsh scripts/build-app.sh         # 通用二进制 + 两份 node
zsh scripts/install-v2.sh        # 备份旧版、安装到 /Applications、装 LaunchAgent
zsh scripts/package-release.sh   # 出 dmg、追加 SHA-256；有公证凭据时会自动公证并装订
```

兼容性验证记录见 `docs/COMPATIBILITY.md`。

### Windows Preview

Windows 版当前版本线为 **2.9.0-windows-preview.1**，目标 Windows 10/11 x64。它不是把 Mac `.app` 改后缀，而是新增 Electron 桌面壳，并把原有核心中的进程发现、窗口关闭、SQLite、磁盘与共享资源行为抽成跨平台实现。

- 依赖官方 ChatGPT/Codex Windows 桌面应用；自动通过 AppX/MSIX 清单发现，找不到时可用 `CMA_CODEX_DESKTOP` 指定可执行文件。
- Windows 包自带 `sqlite3.exe`；窗口共享目录使用 NTFS junction，单文件优先 hard link，不要求管理员创建普通 symlink。
- GitHub Actions 在 `windows-latest` 上运行 Node 回归测试并生成 NSIS 安装版与 portable `.exe`。
- Windows Release 同时提供 `SHA256SUMS-windows.txt`，由 Windows Runner 对最终 `.exe` 逐个计算 SHA-256，便于下载后核验。
- Windows Preview 暂无 Authenticode 代码签名证书，因此首次下载可能出现 Microsoft Defender SmartScreen 提示；这和应用内部功能是否正常是两回事。
- Windows 自动化、打包和纯函数行为由 CI 验证；Microsoft Store/MSIX 客户端在不同机器上的真实 GUI 行为仍欢迎用户反馈。详细说明见 `windows/README.md`。

## 功能

- 第三方模型库与官方 ChatGPT 登录：DeepSeek 等走各自的官方接口，官方入口用 ChatGPT OAuth，互不影响。
- **2.8.3 官方入口唯一化**：官方只保留一个「本机 Codex（官方）」入口。点击它直接启动/激活 `/Applications/Codex.app` 的默认资料，复用你本机已有登录状态、任务库与官方模型选择器；历史 `official-gpt-*` 伪官方条目会自动迁移删除，不再出现在工作窗口模型下拉框。
- 本地模型（Ollama 上的 Ornith / Qwen）降级为**可选供应商**：未通过开发能力验收，已归档，默认不出现，可在「显示归档模型」里查看；重新评估的条件见 `docs/LOCAL-QUALIFICATION.md`。

- 新增和编辑模型、修改 API Key、供应商模板、模型自动发现、搜索、归档恢复。
- 官方 ChatGPT 登录独立入口；DeepSeek 使用官方 `https://api.deepseek.com/v1`。
- 13 类供应商/本地服务模板及自定义模板；未配置凭据的条目明确显示待配置。
- 连接检查、真实推理验证、带时间的验证记录；改 Key / 模型 / 地址 / 协议后失效。
- 每个模型条目独立窗口、任务库和模型配置，多开不修改全局默认模型。
- 窗口多开：任意数量窗口同时运行，每个窗口自带一份 `CODEX_HOME` 与浏览器数据目录（`--user-data-dir` 与 `CODEX_ELECTRON_USER_DATA_PATH` 同值），互不干扰，也和官方 Codex 的 Electron 状态完全隔离；窗口列表里可以新建、打开、关闭、重命名、删除，底层按平台读取真实进程命令行判定哪个窗口在跑（PID 一并显示）。
- 无密钥 JSON 导入导出、原子配置写入、冲突检查、备份、诊断。
- loopback 网关按实例令牌鉴权；Responses、Chat Completions、Anthropic Messages 三类接口。
- 每个窗口都能换模型：窗口的 `config.toml` 指向网关的 `cma_router` 路由，Codex 顶部的模型选择就是全部可切换条目（官方登录与已归档模型不在其中），对话和任务库原地保留。窗口注册表 `windows.json` 记录名称与起始模型（槽位 `router` 沿用历史路径 `router-v1/`，新窗口放 `windows-v1/<id>/`），需要旧对话时再手动导入。
- 侧边栏项目分组随会话一起迁移：桌面端左侧「项目」读的是 `CODEX_HOME/.codex-global-state.json` 而不是 SQLite，导入与修复都会一并补入该文件；同一目录的重复项目按目录去重并改写归属，不会出现两个同名项目。
- 接口自适：自动识别 Responses / Chat / Anthropic 三套接口（真跑一次最小请求判定）、网关遇 404/405 自动换协议并记住、转达供应商错误原因、地址粘贴自动规范化。
- 流式与容灾：Chat / Anthropic 供应商按增量流式输出（首字即时）；可配置「主模型失败改用备用模型」，额度用尽或服务异常时同一次请求内自动切换。
- **2.8 对话账本**：首页直接列出最近活跃的 Codex 对话、当前模型和真实扣费来源。可切换窗口按唯一 router slug 精确反查 route，单模型窗口按 provider ID 精确反查；同名模型的 `-2/-3` 不再被错误合并，宁可显示未知也不猜错账。
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
- 磁盘治理覆盖到缓存：可回收量现在同时统计**会话副本**和**各窗口的浏览器缓存**（`component_crx_cache`、`Default/Cache` 等 24 个白名单目录），只删缓存、不碰 `Cookies` / `Local Storage` / `IndexedDB`，登录态和设置都不会丢，缓存下次打开窗口自动重建。
- 多开不再互相挡清理：以前只要有一个窗口在跑，整个清理就被拒绝；现在只跳过**正在跑的那一个**，其它已关闭窗口照清，并在结果里点名「谁被跳过、留多少」。多开是这个产品的常态，整体拒绝等于永远清不了。
- 启动窗口前自动清理（默认开、可一键关）：打开窗口时，Codex 还没读任务库之前，把这个窗口里「官方已归档」或「超 30 天」的副本连同缓存清掉。**两类窗口都覆盖**——多开的工作窗口（`windows-v1`/`router-v1`）和每个模型的专用窗口（`instances-v2`/`continuations-v1`），后者才是副本堆得最多的地方。判定规则和手动清理完全一致，原件在官方库里随时能再导入，`~/.codex` 与窗口独有对话一律不动。
- 例外只有一处：「导入原会话并继续」**第一次**执行的整份快照不会被立刻清掉（否则刚导入就被当成旧副本删了）；之后这个窗口再启动就照常清理。手动模式始终保留：关掉开关就只在点「清理」时删。
- 运行中的窗口会明说还差多少：侧边栏显示「router 正在运行：还有 5.73 GB 等它关闭后自动清理」，而不是只说一句「正在运行」。这笔钱不算进「可回收」——拿不到的空间不虚报。
- 官方库的**已归档**会话可以单独清：官方库 `~/.codex` 默认只读，唯一例外是这个需要二次确认的按钮/命令（`cleanup-official-plan` / `cleanup-official-apply --confirm`）。它删的是原件、不可恢复，所以只在官方 Codex 未运行时允许执行，并且只碰 `archived = 1` 的会话——那些只是「超过 30 天」但没归档的一条不动。

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
- `windows/`：Windows Electron 主进程、受限 IPC preload 与本地 renderer；不复制业务核心，只调用同一个 `src/product-cli.mjs`。
- `src/platform-runtime.mjs`：macOS / Windows 进程、桌面应用发现、进程树结束、SQLite/tar、共享资源链接等平台适配。
- `src/model-store.mjs`：模型库、凭据、并发与输入校验。
- `src/product-service.mjs`：发现、验证、实例准备、启动、诊断。
- `src/session-transfer.mjs`：会话/项目元数据迁移——任务库合并、导入，以及 `.codex-global-state.json` 的侧边栏项目分组合并（只增不改、按目录去重、原子写入并备份）。
- 官方入口：OpenAI · ChatGPT 登录 开的是**官方那一个** Codex（默认资料 + `~/.codex`，带着你的登录状态和任务库），不再给它造一个空资料窗口；点其它模型时**已经有窗口在跑就切过去**，只有确实没有窗口才新建。
- `src/window-registry.mjs`：窗口注册表（`windows.json`）——窗口标识校验、槽位路径映射、新建编号与名称分配、原子写入 0600。
- `src/disk-cleanup.mjs`：磁盘治理——副本判定（以官方库为权威）、浏览器缓存白名单、清理计划与执行、审计清单、启动前单窗口自动清理。
- `src/disk-policy.mjs`：磁盘策略（启动前自动清理 / 清缓存两个开关），带类型校验与版本递增。
- `src/model-gateway.mjs`、`src/protocol-adapter.mjs`：鉴权网关和协议转换。
- `src/model-windows.mjs`：上下文窗口不写死。按模型名匹配真实窗口（官方模型 272K、Gemini 1M、Claude 200K…），用户自己填的非占位值优先，查不到用 512K 兜底；供应商报错里写着的真实上限会被读出来记回条目。
- `src/context-compaction.mjs`：上下文估算与压缩。会话比模型窗口装得下时，网关静默压缩最早的部分再继续，绝不返回「超过上下文上限」把对话掐断；供应商自己报超限时也补一次压缩重试。估算是按内容算的——文本按字节折算，图片按张计价，`base64` 截图不会被当成十几万 token。
- `src/provider-templates.mjs`：可维护的供应商目录。
- `src/window-registry.mjs`：窗口注册表；单模型窗口按设计不写注册表，由「单模型窗口」列表单独管理。

- `tests/product.test.mjs`、`tests/router.test.mjs`、`tests/session-transfer.test.mjs`、`tests/window-registry.test.mjs`、`tests/gateway-build.test.mjs`、`tests/disk-usage.test.mjs`：产品回归、可切换窗口、项目分组迁移、多窗口、网关指纹，以及磁盘治理（副本判定、缓存白名单、运行中窗口跳过、启动前自动清理、策略读写与幂等）。
- `scripts/smoke-live.mjs`：真实 Codex shell 工具往返验收，会消耗对应供应商额度。
- `scripts/smoke-switch-live.mjs`：可切换窗口验收：模型 A 跑 shell 工具往返，再用模型 B 接着同一会话回答。

## 兼容性

| 项目 | 支持范围 |
|---|---|
| Mac 架构 | **通用二进制**：Apple Silicon（arm64）与 Intel（x86_64）同一份包；node 运行时两份都打包，按架构自动选 |
| Windows Preview | **Windows 10/11 x64**；Electron + 同一套 Node 核心；GitHub `windows-latest` 自动测试与打包 |
| 系统版本 | **macOS 12.0 起**（Monterey）。二进制里写的部署目标是 12.0，Info.plist 同步声明 12.0 |
| 依赖 | macOS 自带 Node 24 运行时；Windows Electron 自带 Node runtime + sqlite3.exe；两端都需要系统里已有官方 ChatGPT/Codex 桌面应用 |

说明：早期版本在 macOS 26 的机器上构建时没有指定 `-target`，二进制里被写成「最低要求 macOS 26」——
Info.plist 写 14.0 也没用，老系统上根本加载不起来。现在 `build-app.sh` 显式指定 `-target <arch>-apple-macos12.0`，
并逐片校验 `LC_BUILD_VERSION.minos`。

详细的版本兼容性验证记录见 `docs/COMPATIBILITY.md`。

详细使用、数据路径、密钥保护与分发条件见 `docs/USER-GUIDE.md`。本次发行是本机验收的签名发布候选，不将未公证或缺少供应商实测的部分宣称为公共商业分发已完成。

## 协议来源

- DeepSeek 官方 Responses：https://api-docs.deepseek.com/guides/responses_api/
- Gemini OpenAI 兼容接口：https://ai.google.dev/gemini-api/docs/openai
- Anthropic API：https://platform.claude.com/docs/en/api/overview
- Ollama 兼容接口：https://docs.ollama.com/api/openai-compatibility

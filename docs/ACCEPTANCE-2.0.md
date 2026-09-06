# 2.0 本机验收记录

日期：2026-09-05。产品状态：可本地运行的签名发布候选，未宣称完成公共商业分发。

## 交付

- 应用：`/Applications/Codex 模型助手.app`
- 安装包：`/Users/shift/Documents/Playground 2/codex-model-assistant/release/Codex-Model-Assistant-2.0.0-arm64.dmg`（约 44 MB）
- 校验文件：`/Users/shift/Documents/Playground 2/codex-model-assistant/release/SHA256SUMS.txt`
- 使用说明：`/Users/shift/Documents/Playground 2/codex-model-assistant/docs/USER-GUIDE.md`

## 本次改动

- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/CodexModelAssistantApp.swift`：模型工作台、搜索、归档、发现、诊断及多开入口。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/ModelEditor.swift`：模板与模型/Key 编辑；官方入口只提供官方模型。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/ModelLibrary.swift`：界面状态、保存及导入导出。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/model-store.mjs`：版本化模型库、私有密钥、原子写入与备份。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/provider-templates.mjs`：13 类供应商/本地模板和自定义模板，18 个初始条目。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/product-service.mjs`：模型发现、真实验证、实例生成与启动。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/product-cli.mjs`：无明文 Key 参数的本机进程协议。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/model-gateway.mjs`：实例鉴权、上游访问、超时和响应限制。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/protocol-adapter.mjs`：Responses / Chat / Anthropic 协议适配。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/tests/product.test.mjs`：新增产品与协议回归。
- `/Users/shift/Documents/Playground 2/codex-model-assistant/scripts/`：校验运行时下载、签名构建、2.0 安装、DMG 打包和真实工具往返验收。

## 自动验收

`npm test`：26 项通过，0 失败。覆盖旧路由回归、增改归档、凭据权限、Key 保留/清除、端点变更密钥隔离、并发冲突、无密钥导入、非法地址、幂等配置生成、三种协议的函数调用、实例令牌隔离、超时、重定向拒绝、错误信息脱敏及验证状态失效。

`codesign --verify --deep --strict`：通过。内置 Node.js 24.20.0，官方归档 SHA-256 校验通过，签名后可执行。`otool -L` 只显示系统框架/库依赖。DMG 的 `hdiutil verify` 和 SHA-256 校验通过。实际私有 Key 扫描覆盖 35 个源码、资源与运行记录文件，未检出泄漏。

## 界面实测

通过真实原生窗口完成：首次添加 → DeepSeek 模板选择 → 保存 → 编辑名称/协议 → 非法带查询参数地址被拒绝 → 修正后保存 → 模型发现返回 3 个官方模型 → 真实推理通过 → 归档 → 归档列表恢复。

修复了首次「添加模型」误用编辑模式而隐藏模板的问题。表单失败保持输入，密钥使用 SecureField。工作台截图已目视检查，无文字重叠或主要按钮缺失。临时兼容接口验收模型最终留在归档中，不占用默认模型库。

## 实际模型与工具

- DeepSeek 官方 Responses 通过新版网关和 Codex CLI 执行 `pwd`，收到 `TOOL_ROUNDTRIP_OK`。
- DeepSeek Chat Completions 经过 Responses 桥接，同样完成 `pwd` 与工具结果往返。
- 5090 Qwen 实际推理验证通过（本次约 4.9 秒）。
- Agnes 模型连接检查通过；未将此项标记为本版工具完整验证。
- 独立新版 DeepSeek Codex 主进程 PID 36381，与原官方 PID 57629 和旧 DeepSeek PID 82117 同时存在；目录各自独立。
- 全局默认模型仍为 `gpt-6-astra`。

实际工具记录：

- `/Users/shift/Documents/Playground 2/codex-model-assistant/output/live-deepseek-flash.log`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/output/live-model-b4b104e3-1eb7-441b-9efc-c88d15857e8c.log`

Codex 主应用窗口的电脑操作接口被工具策略拒绝访问，因此没有声称在新 Codex GUI 内逐条发送消息完成验收。实际调用证据来自同一配置的真实 Codex CLI 和已启动的独立应用进程；助手自身界面的增改恢复已完成 UI 验收。

## 自查与发布条件

- 串账/越权：供应商 Key 不交给 Codex，按实例令牌鉴权；不同模型令牌交叉请求被拒绝。官方订阅与第三方 API 入口分离。
- 幂等/覆盖：路由配置生成幂等；版本冲突拒绝保存；导入创建新条目，不覆盖旧配置。
- 契约：三种接口有 HTTP 契约测试，保留函数调用及结果，不把模型列表出现当作真实推理成功。
- 租户边界：同一 macOS 用户的多模型产品，非多租户 SaaS；共享登录与插件，不能宣传多账号强隔离。
- 已知限制：密钥是 0600 私有文件，非 Keychain 加密；Chat/Anthropic 缓冲完整响应；供应商托管工具不自动映射；进程异常中断保存时可能需要检查残留 `library.lock`。
- 尚未完成：Apple 公证、干净机器/Intel 构建验收、无凭据供应商的实际调用、全部模型长任务/视觉能力。对外销售前应完成这些发布条件并确定品牌、授权和支持条款。

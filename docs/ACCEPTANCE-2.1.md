# 2.1 本地主力与付费专家验收（历史记录）

> **注意：本文记录的「本地主力 / 付费专家」功能已在 2.6.0 整体移除。**
> 以下内容保留为当时的验收证据与结论，不代表当前版本的功能。当前版本见 README。


验收日期：2026-09-05 至 2026-09-06，macOS Apple Silicon，Codex CLI 0.153.4。

## 交付

- 安装应用：`/Applications/Codex 模型助手.app`
- 安装包：`/Users/shift/Documents/Playground 2/codex-model-assistant/release/Codex-Model-Assistant-2.1.0-arm64.dmg`
- 用户说明：`/Users/shift/Documents/Playground 2/codex-model-assistant/docs/USER-GUIDE.md`
- 主任务始终由 Ornith / Qwen 执行，DeepSeek 只返回咨询建议。不是在推理中途替换主模型。
- 每个本地实例启动时接入 MCP，之后专家选择、限额及模式在下一次咨询实时生效。已运行的旧实例需要保存工作、退出再由助手启动；没有强制关闭用户任务。

## 实测证据

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 自动回归 | 40 通过、0 失败 | `/Users/shift/Documents/Playground 2/codex-model-assistant/output/tests-2.1.log` |
| Ornith → DeepSeek → Ornith | 工具完成，本地主力总结建议 | `/Users/shift/Documents/Playground 2/codex-model-assistant/output/expert-s5090-ornith.log`；账本 `1f2b3b0f-4868-4272-bd3b-54e969407ef0` 已完成，203 输入 / 1073 输出 tokens |
| Qwen → DeepSeek → Qwen | 工具完成，本地主力总结建议 | `/Users/shift/Documents/Playground 2/codex-model-assistant/output/expert-s5090-qwen.log`；账本 `60364edf-2f7f-4e79-a429-043c2f78a2de` 已完成，187 输入 / 883 输出 tokens |
| Ornith 简单计算 | 返回 `LOCAL_ONLY_OK 4`，付费次数 2 → 2 | `/Users/shift/Documents/Playground 2/codex-model-assistant/output/expert-s5090-ornith-simple.log` |
| Qwen 简单计算 | 返回 `LOCAL_ONLY_OK 4`，付费次数 2 → 2 | `/Users/shift/Documents/Playground 2/codex-model-assistant/output/expert-s5090-qwen-simple.log` |
| 手动咨询服务 | 已完成，183 输入 / 146 输出 tokens | 账本 `df10f436-f8d2-43e3-8eff-136ec3066578` |
| 原生手动面板 | 2026-09-06 实际填写合成问题、提交并显示答案 | 显示“专家已回答”，当天调用 0 → 1，182 输入 / 499 输出 tokens |
| 原生重复提交 | 第二次显示“已复用缓存” | 当天调用保持 1，tokens 未增加；冷却期内没有再次付费请求 |
| 原生策略保存/历史 | 保存回读成功；可见进行中及已完成记录 | 原生 AX 交互验收 |
| 配置隔离 | 全局仍为 `gpt-6-astra` | 未把全局模型改为本地或第三方模型 |

真实测试曾发现并修复：旧 5090 Responses 中继过滤命名空间工具及调用历史；只读审批模式拒绝专家工具；DeepSeek 默认 thinking 在短输出预算内未产出正文。修复后两条本地工具闭环均由日志与 SQLite 记录交叉核对。

首次失败的 Qwen 专家请求保留在账本中，不删除、不退款、不伪造 token 数。它占一次请求，已知用量为空，不能解释为供应商免费。Qwen 成功测试与手动服务测试发生并发，旧冒烟脚本以全局增量判定导致误报；现已改为按调用方计数，避免其他实例的正常请求污染结果。没有为消除误报反复发送付费请求。

## 改动文件清单

- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/expert-policy.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/expert-ledger.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/expert-service.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/expert-mcp.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/local-expert-config.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/product-service.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/product-cli.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/src/model-store.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/ExpertSettingsView.swift`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/ModelLibrary.swift`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Sources/CodexModelAssistantApp.swift`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/tests/expert.test.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/tests/product.test.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/scripts/smoke-expert-live.mjs`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/scripts/package-release.sh`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/Info.plist`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/README.md`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/docs/USER-GUIDE.md`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/docs/local-expert-design.md`
- `/Users/shift/Documents/Playground 2/codex-model-assistant/docs/ACCEPTANCE-2.1.md`

## 自查与边界

- 串账/并发：按 caller 保存记录，SQLite 写事务在网络请求前预占每日全局及调用方额度；重启不重置额度。
- 幂等：相同摘要和专家配置缓存 24 小时，pending 不重复发送，失败不自动重试。
- 越权：仅两个本地主力 ID 可调用；工具参数不能覆盖地址、Key 或限额；仅手动和禁用模式由服务端执行。
- 契约漂移：Chat 桥接有命名空间、调用及返回历史回归；仅明确匹配旧预设时迁移并备份。
- 租户边界：本产品是单 macOS 用户本地工具，不是多租户 SaaS；实例隔离不等同于安全账户隔离。
- 额度为次数/长度上限，不是金额上限。拥有同用户无限制 shell 的不可信代理仍可能读取或改写本地配置；不宣称防恶意代理沙箱。
- 应用使用 ad-hoc 签名，尚未 Apple 公证、干净机器分发验收；未填 Key 的供应商未做真实调用。不能宣称公共商业分发全部完成。

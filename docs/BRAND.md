# Model Router 品牌规范

## 品牌名称

- 英文主名：**Model Router**
- 中文名：**模型路由助手**
- 描述线：**ChatGPT Desktop · Codex · Multi-Provider**
- 定位：面向桌面 AI 工作流的非官方模型路由、多窗口和 provider 管理工具。

## 品牌原则

1. **独立、非官方**：不得让用户误认为 Model Router 是 OpenAI 或任何供应商官方产品。
2. **Router 优先**：品牌核心是“路由 / 连接 / 层级 / 工作流”，不模仿任何模型厂商主品牌图形。
3. **统一桌面体验**：macOS 和 Windows 使用同一品牌、同一核心视觉语言。
4. **兼容优先**：3.0 只改显示品牌，内部 bundle id、数据目录和 LaunchAgent 暂不迁移。

## 视觉资产

- `assets/brand/model-router-logo.png`：横版主标识。
- `assets/brand/model-router-app-icon.png`：高分辨率 App Icon 母版。
- `assets/brand/model-router-hero.png`：GitHub / Release Hero。
- `assets/brand/model-router-brand-guide.png`：品牌总览。
- `Resources/ModelRouter.icns`：macOS。
- `Resources/ModelRouter.ico`：Windows。

## 色彩

- Electric Blue：`#00B0FF`
- Cyan Accent：`#00E5FF`
- Pure White：`#F8FAFF`
- Slate Surface：`#1F2A3A`
- Charcoal Background：`#0A0F17`

## 命名规范

用户可见：

- App：`Model Router`
- 中文文档：`Model Router / 模型路由助手`
- macOS DMG：`Model-Router-<version>-universal.dmg`
- Windows Setup：`Model Router Setup <version>.exe`
- Windows Portable：`Model Router <version>.exe`

内部兼容：

- Bundle ID：`local.shift.codex-model-assistant`
- Data root：`~/.codex/model-assistant`
- Gateway label：`local.shift.codex-model-gateway`

这些内部名称直到有完整迁移器之前不要修改。

## 第三方商标

README 和 UI 可以描述兼容 ChatGPT Desktop、Codex、DeepSeek、Anthropic、Gemini 等，但不得使用仿制官方商标作为 Model Router 主品牌，也不得暗示官方合作关系。

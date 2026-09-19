# Model Router · Windows

Model Router Windows 版使用 Electron 作为桌面壳，但所有模型、路由、网关、窗口注册表、会话账本都复用根目录 `src/` 的同一套 Node 核心。

当前首页固定展示「ChatGPT Desktop（官方）」卡片，第三方/可切换窗口与官方原版明确分开；模型库支持名称、供应商、模型 ID、地址搜索，并使用紧凑三行卡片，避免模型数量增加后页面过长难找。

## 运行前提

- Windows 10/11 x64。
- 已安装 OpenAI 官方 ChatGPT/Codex Windows 桌面应用。当前官方 Store Product ID 为 `9PLM9XGG6VKS`。
- 正式包自带 `sqlite3.exe`；源码开发时可以设置 `CMA_SQLITE3`。
- 如自动发现官方桌面应用失败，可设置 `CMA_CODEX_DESKTOP=C:\\...\\ChatGPT.exe`。

## 本地开发

```powershell
npm install
$env:CMA_SQLITE3=(Get-Command sqlite3.exe).Source
npm run win:dev
```

## 打包

```powershell
npm ci
npm run win:dist
```

打包由 GitHub Actions 的 `windows-latest` 完成，并输出 NSIS 安装版与 portable 版。

## 当前边界

这是 Windows Preview。自动化测试与 Windows CI 可以保证 Node 核心、Electron 启动和打包结构稳定，但没有替代真实 Windows 用户对 Microsoft Store/MSIX 客户端版本差异的人工验收。发现官方应用失败时优先使用 `CMA_CODEX_DESKTOP` 覆盖路径。

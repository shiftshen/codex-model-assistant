---
name: macos-release
description: Automatically use this skill when packaging, signing, notarizing, stapling, verifying, or publishing a macOS desktop application. Covers SwiftUI, Tauri, Electron, Python sidecars, Developer ID, notarytool, DMG, updater artifacts, Windows companion CI, tags, and GitHub Release verification without exposing private signing credentials.
---

# macOS Release Skill

用于将 SwiftUI、Tauri、Electron 或其它 macOS 桌面项目从“本机能运行”提升到可公开分发的正式发布包。

## 安全原则

- 可以使用钥匙串中的 Developer ID 证书与 notarytool keychain profile。
- 可以引用 updater 私钥的**路径**，但禁止读取、打印、复制、上传或提交私钥内容。
- 禁止输出 P12 密码、Apple App 专用密码、App Store Connect API 私钥内容。
- 新电脑通过钥匙串安全导入证书/P12；私钥不得进入 Git、聊天记录或源码。

## 1. 发布前验证

按项目技术栈运行全部测试和构建检查，例如：

```bash
python -m pytest -q
npm test
npm run build
cargo check
```

必须保证测试全绿、Git worktree 可解释，并执行：

```bash
git diff --check
git status --short
```

## 2. Developer ID 签名

确认签名身份：

```bash
security find-identity -v -p codesigning
```

推荐显式身份：

```text
Developer ID Application: Chinda Lorcharoen (PGJ5BY2925)
```

签名顺序原则：先签最内层 Mach-O / sidecar / helper / runtime，再签 Framework、App，最后校验。

```bash
codesign --verify --deep --strict --verbose=4 /path/MyApp.app
```

## 3. Apple 公证

只使用 keychain profile，不在命令行暴露凭据。

当前机器可用 profile 示例：

```text
xbrowser-notary
```

先验证：

```bash
xcrun notarytool history --keychain-profile xbrowser-notary
```

### 公证 App

```bash
ditto -c -k --keepParent MyApp.app MyApp-app.zip
xcrun notarytool submit MyApp-app.zip --keychain-profile xbrowser-notary --wait
xcrun stapler staple MyApp.app
xcrun stapler validate MyApp.app
spctl --assess --type execute --verbose=4 MyApp.app
```

正确结果应包含：

```text
accepted
source=Notarized Developer ID
The validate action worked!
```

## 4. 生成并公证 DMG

只在 App 已成功 staple 后生成最终 DMG：

```bash
hdiutil create ... MyApp-X.Y.Z.dmg
xcrun notarytool submit MyApp-X.Y.Z.dmg --keychain-profile xbrowser-notary --wait
xcrun stapler staple MyApp-X.Y.Z.dmg
xcrun stapler validate MyApp-X.Y.Z.dmg
hdiutil verify MyApp-X.Y.Z.dmg
```

最后再生成 SHA-256；不要在 staple 前计算最终摘要。

```bash
shasum -a 256 MyApp-X.Y.Z.dmg
```

## 5. 自动更新产物

若项目有 Tauri/Sparkle/自定义 updater：

- updater 私钥只通过安全路径传入。
- 生成更新压缩包与签名。
- 不打印私钥正文。
- Release manifest 中记录版本、URL、SHA256/签名。

## 6. Windows CI

没有 Windows 实机时，Windows 包必须至少经过：

- GitHub `windows-latest`
- 单元/核心测试
- Setup 构建
- Portable 构建
- SHA256
- Artifact 上传

真实 GUI/MSIX/Store 行为应明确标记为 Preview，直到真实 Windows 机器验收。

## 7. Git/Tag 一致性

正式发布前：

```bash
git rev-parse HEAD
git rev-parse origin/main
git rev-list -n1 vX.Y.Z
```

正式 Release 时三者必须指向同一个提交。

## 8. GitHub Release

Release 最少包含：

- macOS DMG
- macOS SHA256
- Windows Setup
- Windows Portable
- Windows SHA256
- Release Notes

上传后对每个下载链接做真实 HTTP 200 验证。

## 9. 最终验收清单

- Tests PASS
- App codesign PASS
- App notarization Accepted
- App stapler PASS
- App `spctl` = accepted / Notarized Developer ID
- DMG notarization Accepted
- DMG stapler PASS
- DMG verify PASS
- SHA256 最终值已记录
- HEAD = origin/main = tag commit
- GitHub assets 全部可下载

## 10. 常见错误

- **只签名不公证**：别人的 Mac 首次打开仍可能被 Gatekeeper 拦截。
- **先生成 DMG、再 staple App**：DMG 里的 App 没票据，必须重新生成 DMG。
- **staple 后不重算 SHA256**：最终摘要会错。
- **用 `codesign --deep --force` 代替逐层签名**：复杂 Tauri/Electron/sidecar 项目容易漏签，正式项目应逐层签。
- **把密钥放环境输出或 GitHub 日志**：严格禁止。

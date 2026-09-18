# 兼容性验证记录

目标：同一份发行包能在 Apple Silicon 和 Intel 的 Mac 上打开并使用。

## 怎么做到

`scripts/build-app.sh` 做的事：

1. 用 `swiftc -target <arch>-apple-macos12.0` 分别编译 arm64 与 x86_64 两份，再 `lipo -create` 合成通用二进制。
   - **必须显式给 `-target`**：不给的话 swiftc 会按构建机的 SDK 写 `LC_BUILD_VERSION.minos`。
     早期版本在 macOS 26 的机器上构建，二进制里写的是「最低要求 26.0」，Info.plist 声明 14.0 也救不回来——
     老系统上 dyld 直接拒绝加载。
2. 打包两份 node 运行时（`Resources/node-arm64`、`Resources/node-x64`），运行时按架构选
   （`LibraryViewModel.bundledNode(in:)`，用 `#if arch(arm64)` 判断当前加载的是哪一片）。
3. `Contents/Resources/node` 保留一份构建机架构的副本，兼容旧路径。
4. 三个 node 可执行文件单独签名（带 `Resources/node-entitlements.plist`），主程序再签。

`scripts/install-v2.sh` 写 LaunchAgent 时会按 `uname -m` 选择 `node-arm64` / `node-x64`，
并且**必须在 app ditto 到位之后**再探测——早期版本把这段放在 ditto 之前，结果永远探测到旧 app、
回退成写死的 `Contents/Resources/node`。

## 实测证据（在 Apple Silicon / macOS 26 上）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 主程序架构 | `lipo -archs` | `x86_64 arm64` |
| arm64 切片最低系统 | `otool -l -arch arm64 … \| grep minos` | `12.0` |
| x86_64 切片最低系统 | `otool -l -arch x86_64 … \| grep minos` | `12.0` |
| 签名 | `codesign --verify --deep --strict` | 通过 |
| x64 运行时真的能跑 | `arch -x86_64 …/node-x64 -p "process.arch"` | `x64 \| darwin \| v24.20.0` |
| x64 跑完整网关脚本 | `arch -x86_64 …/node-x64 runtime-v2/model-gateway.mjs` | `Model gateway already running on loopback`，退出码 0 |
| x86_64 切片能启动 | `arch -x86_64 …/CodexModelAssistant` | 进程存活 6 秒以上，无崩溃输出 |
| 对照组 | `arch -x86_64 …/node-arm64` | `Bad CPU type in executable`（证明缺切片时 arch 会立刻报错） |

对照那一行是关键：如果主程序没有 x86_64 切片，`arch -x86_64` 会立刻报错而不是存活 6 秒。

## 做到什么程度

- **已实测**：编译期两个架构都通过；x86_64 运行时与网关脚本在 Rosetta 下真正跑起来；
  arm64 上完整安装、启动、真实请求（HTTP 200，流式正常）。
- **未实测**：没有 Intel 机器，也没有 macOS 12/13 的实机，所以「在 12.0 上界面表现」没有运行时证据，
  只有编译期证据（`-target macos12.0` 通过，且已把唯一两个 14+ 的 API 换掉：
  `ContentUnavailableView` → 自绘空状态；`.defaultSize` → 窗口出现时代码设定尺寸；
  另去掉 `formStyle(.grouped)` 与 `onChange` 的双参数写法）。
- 若日后拿到 Intel 或 macOS 12/13 实机，应按上表重跑一遍，并把结果补进本文件。

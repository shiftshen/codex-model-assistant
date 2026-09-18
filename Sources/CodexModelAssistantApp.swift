import AppKit
import SwiftUI

struct ModelLibraryView: View {
    @StateObject private var library = LibraryViewModel()
    @State private var editing: ManagedModel?
    @State private var renameTarget: WorkWindow?
    @State private var renameDraft = ""

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("模型工作台").font(.callout.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button { Task { await library.refresh() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新配置")
                    Menu {
                        Button("导入模型配置…") { Task { await library.importLibrary() } }
                        Button("导出模型配置…") { Task { await library.exportLibrary() } }
                        Divider()
                        Button("运行诊断") { Task { await library.perform("diagnostics") } }
                        Button("打开数据目录") { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.codex/model-assistant")) }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).frame(width: 28).help("备份与诊断")
                }.padding(24).disabled(library.busy)
                Divider()
                if library.diskNeedsAttention, let disk = library.disk {
                    HStack(spacing: 10) {
                        Image(systemName: "internaldrive.fill").foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("助手目录占 \(humanBytes(disk.totalBytes))，可回收 \(humanBytes(disk.reclaimable))").font(.caption.weight(.semibold))
                            Text("多开的窗口各存了一份同样的会话；清理只删副本，官方库和窗口独有对话不动。").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("去清理") { library.showCleanupConfirm = true }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .disabled(library.busy || disk.reclaimable <= 0)
                    }
                    .padding(.horizontal, 24).padding(.vertical, 10)
                    .background(Color.orange.opacity(0.1))
                    Divider()
                }
                if let selected = library.selected { detail(selected) }
                else { ContentUnavailableView("还没有模型", systemImage: "square.stack.3d.up", description: Text("点击添加模型，选择供应商模板开始配置。")) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 920, minHeight: 660)
        .sheet(item: $editing) { model in ModelEditor(library: library, draft: model, isNew: !library.models.contains(where: { $0.id == model.id })) }
        .sheet(isPresented: $library.showDiscovery) { discovery }
        .sheet(isPresented: $library.showDiagnostics) {
            VStack(alignment: .leading, spacing: 20) {
                Text("运行诊断").font(.title2.bold())
                Text(library.diagnostics).font(.body).textSelection(.enabled).lineSpacing(8)
                HStack {
                    Button("修复工作窗口") { Task { await library.callRepairAndRefreshDiagnostics() } }.disabled(library.busy)
                    Spacer()
                    Button("完成") { library.showDiagnostics = false }.keyboardShortcut(.defaultAction)
                }
            }.padding(28).frame(width: 600)
        }
        .sheet(isPresented: $library.showExpert) { ExpertSettingsView(library: library) }
        .sheet(isPresented: $library.showSwitch) { switchWindow }
        .task {
            await library.refresh()
            // 启动时就把磁盘占用算出来，超阈值时下面的提示条才有内容。
            await library.refreshDisk()
        }
    }

    private var switchWindow: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "macwindow.on.rectangle").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("窗口管理").font(.title2.bold())
                    Text("每个窗口都是独立的 Codex 窗口，可以同时开多个；每个窗口里都能在 Codex 顶部直接换模型，对话不会丢。").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(library.windows.count) 个窗口 · 运行中 \(library.runningWindowCount)")
                    .font(.caption.weight(.semibold)).foregroundStyle(library.runningWindowCount > 0 ? .green : .secondary)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background((library.runningWindowCount > 0 ? Color.green : Color.secondary).opacity(0.12), in: Capsule())
            }
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(library.windows) { window in windowRow(window) }
                    if !library.orphans.isEmpty { orphanRow }
                }
            }
            .frame(minHeight: 190)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("新建窗口").font(.callout.weight(.semibold))
                Text("新窗口按约定是空的（需要旧对话时用下面的导入）。起始模型只是打开时的默认值；窗口会记住它，之后在 Codex 里随时换。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Picker("起始模型", selection: $library.newWindowModel) {
                        ForEach(library.switchModels) { entry in Text("\(entry.name) · \(entry.model)").tag(entry.id) }
                    }.frame(maxWidth: 380)
                    Button("新建窗口") { Task { await library.newWindow(initial: library.newWindowModel) } }
                        .buttonStyle(.borderedProminent).disabled(library.busy || library.switchModels.isEmpty)
                    Spacer()
                }
                Text("可选 \(library.switchModels.count) 个模型（官方 ChatGPT 登录和已归档模型不在这里）。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("把已有会话带进来").font(.callout.weight(.semibold))
                Text("先打开过窗口 1（内置），让 Codex 建好任务库并退出，再在这里导入。导入只新增副本，不会改动官方或其它模型窗口的会话。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button("导入官方会话") { Task { await library.importHistory("shared") } }.disabled(library.busy)
                    Button("导入全部（官方 + 各模型窗口）") { Task { await library.importHistory("all") } }.disabled(library.busy)
                    Button("修复工作窗口") { Task { await library.perform("repair-work-window") } }.disabled(library.busy)
                }
            }
            if library.busy { ProgressView().controlSize(.small) }
            HStack {
                Text(library.message).font(.caption).foregroundStyle(library.success == false ? .red : .secondary).lineLimit(3)
                Spacer()
                Button("完成") { library.showSwitch = false }.keyboardShortcut(.cancelAction)
                Button("刷新状态") { Task { await library.openSwitch() } }.disabled(library.busy)
            }
        }
        .padding(24).frame(width: 700, height: 700)
        .sheet(item: $renameTarget) { window in
            VStack(alignment: .leading, spacing: 16) {
                Text("重命名窗口").font(.title3.bold())
                TextField("窗口名称", text: $renameDraft).textFieldStyle(.roundedBorder).frame(width: 320)
                HStack {
                    Spacer()
                    Button("取消") { renameTarget = nil }.keyboardShortcut(.cancelAction)
                    Button("保存") {
                        let target = window.id
                        let name = renameDraft
                        renameTarget = nil
                        Task { await library.renameWindow(target, to: name) }
                    }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                }
            }.padding(24)
        }
    }

    private func windowRow(_ window: WorkWindow) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(window.name).font(.system(size: 13, weight: .semibold))
                    if window.legacy == true {
                        Text("内置").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 2).background(Color.secondary.opacity(0.14), in: Capsule())
                    }
                    if window.running == true {
                        Text("运行中 · PID \(window.pid ?? 0)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.green)
                    }
                }
                Text("起始模型：\(library.models.first { $0.id == window.initialModel }?.name ?? "自动")")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Text(window.homePath ?? "").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if window.running == true {
                Button("置前") { Task { await library.bringWindowToFront(window.id) } }
                    .disabled(library.busy)
                    .help("这个窗口开着但被压住/最小化时，用它切到最前")
                Button("关闭") { Task { await library.closeWindow(window.id) } }.disabled(library.busy)
            } else {
                Button("打开") { Task { await library.openWindow(window.id) } }
                    .disabled(library.busy)
            }
            Menu {
                Button("用这个窗口的起始模型再开一个") { Task { await library.newWindow(initial: window.initialModel ?? "") } }
                    .disabled(library.busy)
                Button("重命名…") { renameDraft = window.name; renameTarget = window }
                Divider()
                Button("删除窗口", role: .destructive) { Task { await library.deleteWindow(window.id) } }
                    .disabled(window.legacy == true || window.running == true)
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).frame(width: 28)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    // 并发建窗丢过记录时，Codex 进程还在跑但注册表里没有它：这里一次性接管回来。
    private var orphanRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("发现 \(library.orphans.count) 个没登记的 Codex 窗口").font(.system(size: 13, weight: .semibold))
            }
            Text("这些窗口的进程还在运行（\(library.orphans.map { "PID \($0.pid ?? 0)" }.joined(separator: "、"))），但之前不在列表里，所以看起来像「只能开一个」。接管之后就能在列表里关闭或重新打开，不会影响正在进行的对话。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            HStack {
                Button("接管这些窗口") { Task { await library.adoptOrphans() } }.disabled(library.busy)
                Spacer()
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up.fill").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Codex 模型助手").font(.headline)
                    Text("MODEL ROUTER · 2.3").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                }
            }.padding(.top, 8)
            TextField("搜索模型或供应商", text: $library.search).textFieldStyle(.roundedBorder)
            HStack {
                Text(library.showArchived ? "已归档" : "模型库").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text("\(library.visible.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(library.visible) { model in
                        Button { library.select(model.id) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: model.icon).foregroundStyle(model.color).frame(width: 28)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(model.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                        if model.id == library.preferredLocalID {
                                            Text("主力").font(.system(size: 9, weight: .bold)).foregroundStyle(.blue).padding(.horizontal, 5).padding(.vertical, 2).background(Color.blue.opacity(0.1), in: Capsule())
                                        } else if library.isLocal(model) {
                                            Text("备用").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary).padding(.horizontal, 5).padding(.vertical, 2).background(Color.secondary.opacity(0.1), in: Capsule())
                                        }
                                    }
                                    HStack(spacing: 6) {
                                        Text(model.model.isEmpty ? "尚未选择模型 ID" : model.model).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                        if library.isRunning(model) { Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.green).help("此 Codex 实例已启动") }
                                        if library.isLoaded(model) { Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundStyle(.orange).help("Ollama 当前已加载此模型") }
                                    }
                                }
                                Spacer(minLength: 4)
                                if !model.ready { Image(systemName: "wrench.and.screwdriver").font(.caption).foregroundStyle(.secondary) }
                            }
                            .padding(10).contentShape(Rectangle())
                            .background(library.selectedID == model.id ? Color.accentColor.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain).accessibilityLabel("选择 \(model.name)").disabled(library.busy)
                    }
                    if library.visible.isEmpty { Text("没有匹配的模型").foregroundStyle(.secondary).padding(.top, 30) }
                }
            }
            Divider()
            diskSection
            Button { Task { await library.newWindow(initial: library.newWindowModel) } } label: { Label("新建可切换窗口", systemImage: "macwindow.badge.plus").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).disabled(library.busy || library.switchModels.isEmpty)
                .help("再开一个独立的 Codex 窗口：它有自己的任务库和运行状态，可以和现有窗口同时干活，窗口里随时换模型")
            Button { Task { await library.openSwitch() } } label: { Label("窗口管理（\(library.windows.count)）", systemImage: "macwindow.on.rectangle").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).disabled(library.busy || library.switchModels.isEmpty)
                .help("打开、关闭、重命名、删除窗口，也可以在这里新建窗口")
            Button { Task { await library.openExpert() } } label: { Label("本地优先 / 专家策略", systemImage: "person.crop.circle.badge.checkmark").frame(maxWidth: .infinity) }
                .disabled(library.busy)
            Button { editing = ManagedModel.new() } label: { Label("添加模型", systemImage: "plus").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(library.busy)
            Toggle("显示归档模型", isOn: $library.showArchived).toggleStyle(.checkbox).font(.caption)
            Toggle("显示隐藏条目", isOn: $library.showHidden).toggleStyle(.checkbox).font(.caption)
            Text("\(library.readyCount) 个配置就绪 · 同一本地服务请求排队执行").font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(width: 270).background(Color(nsColor: .controlBackgroundColor))
    }

    // 磁盘：同一批会话在每个窗口各存一份，是这套多开机制最容易失控的地方，所以放在侧边栏常驻可见。
    private var diskSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("磁盘").font(.caption.weight(.semibold))
                Spacer()
                if let disk = library.disk {
                    Text("可回收 \(humanBytes(disk.reclaimable))")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(disk.reclaimable > 0 ? .orange : .secondary)
                }
            }
            if let disk = library.disk {
                Text("助手目录 \(humanBytes(disk.totalBytes)) · 系统剩余 \(Int(disk.freeDiskPercent.rounded()))%")
                    .font(.caption2).foregroundStyle(.secondary)
                if let plan = library.diskPlan, let count = plan.items?.count, count > 0 {
                    Text("\(count) 个会话副本可清 · \(plan.keepOriginals?.count ?? 0) 条原件保留")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let skipped = library.diskPlan?.skipped, !skipped.isEmpty {
                    Text("\(skipped.map(\.id).joined(separator: "、")) 正在运行，关闭后再清")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("点「检查占用」算出可回收多少").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Button { Task { await library.refreshDisk() } } label: { Label("检查占用", systemImage: "internaldrive").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).disabled(library.busy)
                Button { library.showCleanupConfirm = true } label: { Label("清理", systemImage: "trash").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).disabled(library.busy || (library.disk?.reclaimable ?? 0) <= 0)
                    .help("删除各窗口里重复的会话副本，释放磁盘；官方库和窗口独有对话不动")
            }
        }
        .confirmationDialog("确认清理会话副本？", isPresented: $library.showCleanupConfirm, titleVisibility: .visible) {
            Button("删除并释放空间", role: .destructive) { Task { await library.applyCleanup() } }
            Button("取消", role: .cancel) { }
        } message: {
            Text(library.cleanupPrompt)
        }
    }

    private func detail(_ model: ManagedModel) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.vendor).font(.callout).foregroundStyle(.secondary)
                    Text(model.name).font(.system(size: 27, weight: .bold)).lineLimit(2)
                    Text(model.protocol == "oauth" ? "官方 ChatGPT 登录" : (model.noKey ? "本机 / 局域网服务" : "API Key · 由供应商独立计费")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.status).font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 6)
                    .background(model.ready ? Color.blue.opacity(0.1) : Color.orange.opacity(0.12), in: Capsule())
            }
            VStack(spacing: 0) {
                row("模型 ID", model.model.isEmpty ? "未选择 · 使用发现模型或编辑" : model.model)
                Divider()
                row("API 地址", model.protocol == "oauth" ? "ChatGPT 官方服务" : model.endpoint)
                Divider()
                row("接口格式", model.protocol == "oauth" ? "官方登录" : model.protocol)
                Divider()
                row("密钥状态", model.protocol == "oauth" ? "使用 Codex 登录信息" : (model.noKey ? "无需密钥" : (model.hasKey == true ? "已保存 · 不展示原文" : "未配置 API Key")))
                Divider()
                row("可切换窗口", model.protocol == "oauth" ? "官方入口自带模型选择" : (model.archived ? "已归档，不收录" : (library.switchModels.contains { $0.id == model.id } ? "已收录 · 同一窗口直接换" : "未收录")))
                Divider()
                row("本窗口模型", model.protocol == "oauth" ? "官方模型选择" : (model.switchable == true ? "可切换全部模型" : "仅此模型"))
                Divider()
                row("失败时改用", model.protocol == "oauth" ? "不适用" : (model.fallback.flatMap { id in library.models.first { $0.id == id }?.name } ?? "未设置"))
            }.padding(.horizontal, 16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 10) {
                Button("编辑配置 / Key") { editing = model }
                Button("发现模型") { Task { await library.perform("discover") } }.disabled(!model.noKey && model.hasKey != true && model.protocol != "oauth")
                Button("自动识别接口") { Task { await library.perform("autodetect") } }.disabled(!model.ready || model.archived || model.protocol == "oauth").help("逐个真跑一次最小请求，自动判断该供应商用的是 Responses、Chat 还是 Messages，并保存结果")
                if !model.docs.isEmpty, let url = URL(string: model.docs) { Link("官方文档 ↗", destination: url).font(.callout) }
                Spacer()
            }.disabled(library.busy)
            if !model.notes.isEmpty { Text(model.notes).font(.callout).foregroundStyle(.secondary).lineLimit(3) }
            HStack(alignment: .top, spacing: 10) {
                if library.busy { ProgressView().controlSize(.small) }
                else { Image(systemName: library.success == false ? "exclamationmark.circle.fill" : (library.success == true ? "checkmark.circle.fill" : "info.circle")) }
                Text(library.message).font(.callout).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(library.success == false ? Color.red : Color.primary)
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(library.success == false ? Color.red.opacity(0.07) : Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            if library.isLocal(model) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label(model.id == library.preferredLocalID ? "当前本地主力" : "备用本地模型", systemImage: model.id == library.preferredLocalID ? "checkmark.seal.fill" : "moon.zzz")
                        Spacer()
                        Text(library.isRunning(model) ? "Codex 已启动" : "Codex 未启动").foregroundStyle(library.isRunning(model) ? .green : .secondary)
                    }.font(.callout.weight(.semibold))
                    Text(library.isLoaded(model) ? "Ollama 当前已加载此模型，占用显存。" : "Ollama 当前未常驻加载此模型；只有收到请求时才会载入。").font(.caption).foregroundStyle(.secondary)
                    Text("同一本地服务的请求排队执行；等待期间保持连接。配置就绪不代表已通过开发能力验收。").font(.caption).foregroundStyle(.secondary)
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }
            Spacer(minLength: 0)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "macwindow.on.rectangle").foregroundStyle(.secondary)
                Text(["s5090-ornith", "s5090-qwen"].contains(model.id) ? "本地服务按请求排队。付费专家调用由策略控制；已归档模型不能启动。" : "只想换模型、继续同一个对话：用「在可切换窗口中打开」，之后在 Codex 顶部的模型选择里直接换，窗口和对话不变。想给某个模型单独一个专用窗口：用「启动 Codex」，旧任务可用「导入原会话并继续」复制一份；副本与原件不会自动同步，任务内容都会发送给所选供应商。").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if model.id != "official" { Button(model.archived ? "恢复模型" : "归档") { Task { await library.archive() } } }
                Spacer()
                Button("检查连接") { Task { await library.perform("check") } }.disabled(!model.ready || model.archived)
                Button("真实验证") { Task { await library.perform("probe") } }.disabled(!model.ready || model.archived || model.protocol == "oauth").help("发送短测试请求，消耗少量供应商额度")
                Button("在新窗口打开") { Task { await library.newWindow(initial: model.id) } }.buttonStyle(.borderedProminent).disabled(!model.ready || model.archived)
                    .help("新建一个独立 Codex 窗口，用这个模型作为起始模型；窗口里的全部模型都能在 Codex 顶部直接换")
                Menu {
                    Button("独立窗口（单模型）") { Task { await library.perform("launch") } }.disabled(!model.ready || model.archived)
                    if model.protocol != "oauth" {
                        Button("导入官方会话并继续") { Task { await library.perform("continue") } }.disabled(!model.ready || model.archived)
                    }
                    if model.switchable == true {
                        Button("本窗口改为单模型") { Task { await library.perform("disable-switching") } }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).frame(width: 28)
            }.disabled(library.busy)
        }.padding(28)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(spacing: 16) {
            Text(label).font(.callout).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
            Text(value).font(.system(size: 12, weight: .medium, design: .monospaced)).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
            Spacer(minLength: 0)
        }.padding(.vertical, 12)
    }

    private var discovery: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("选择供应商模型").font(.title2.bold())
            Text("供应商当前返回 \(library.discovered.count) 个模型。保存后请执行真实验证。").font(.callout).foregroundStyle(.secondary)
            TextField("筛选模型 ID", text: $library.discoveryFilter).textFieldStyle(.roundedBorder)
            List(library.discovered.filter { library.discoveryFilter.isEmpty || $0.localizedCaseInsensitiveContains(library.discoveryFilter) }, id: \.self) { id in
                Button {
                    guard var model = library.selected else { return }
                    model.model = id
                    Task { if await library.save(model) { library.showDiscovery = false } }
                } label: { HStack { Text(id); Spacer(); Image(systemName: "plus.circle") } }
                .buttonStyle(.plain).disabled(library.busy)
            }
            HStack { Spacer(); Button("关闭") { library.showDiscovery = false }.keyboardShortcut(.cancelAction) }
        }.padding(24).frame(width: 600, height: 530)
    }
}

@main
struct CodexModelAssistantApp: App {
    var body: some Scene {
        WindowGroup { ModelLibraryView() }
            .defaultSize(width: 1050, height: 730)
            .commands { CommandGroup(replacing: .newItem) { } }
    }
}

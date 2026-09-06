import AppKit
import SwiftUI

struct ModelLibraryView: View {
    @StateObject private var library = LibraryViewModel()
    @State private var editing: ManagedModel?

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
                HStack { Spacer(); Button("完成") { library.showDiagnostics = false }.keyboardShortcut(.defaultAction) }
            }.padding(28).frame(width: 600)
        }
        .sheet(isPresented: $library.showExpert) { ExpertSettingsView(library: library) }
        .task { await library.refresh() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up.fill").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Codex 模型助手").font(.headline)
                    Text("LOCAL FIRST · 2.1").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
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
            VStack(alignment: .leading, spacing: 6) {
                Text("当前本地主力：\(library.preferredLocalName)").font(.caption.weight(.semibold))
                Text(library.localStatus?.message ?? "正在读取本地运行状态…").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
            Button { Task { await library.launchPreferredLocal() } } label: { Label("启动本地主力", systemImage: "play.circle.fill").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).disabled(library.busy)
            Button { Task { await library.openExpert() } } label: { Label("本地优先 / 专家策略", systemImage: "person.crop.circle.badge.checkmark").frame(maxWidth: .infinity) }
                .disabled(library.busy)
            Button { editing = ManagedModel.new() } label: { Label("添加模型", systemImage: "plus").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(library.busy)
            Toggle("显示归档模型", isOn: $library.showArchived).toggleStyle(.checkbox).font(.caption)
            Text("\(library.readyCount) 个配置就绪 · 多开独立，同一本地模型串行").font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(width: 270).background(Color(nsColor: .controlBackgroundColor))
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
            }.padding(.horizontal, 16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 10) {
                Button("编辑配置 / Key") { editing = model }
                Button("发现模型") { Task { await library.perform("discover") } }.disabled(!model.noKey && model.hasKey != true && model.protocol != "oauth")
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
                    Text(model.id == library.preferredLocalID ? "建议让主力处理日常开发；同一本地模型两个对话会串行，长任务压缩时第二个会被拒绝。" : "备用模型适合单独开另一个任务对照；同一张 5090 同时跑 Ornith 和 Qwen 会抢显存与速度。").font(.caption).foregroundStyle(.secondary)
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }
            Spacer(minLength: 0)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "macwindow.on.rectangle").foregroundStyle(.secondary)
                Text(["s5090-ornith", "s5090-qwen"].contains(model.id) ? "本地主力执行，按需调用付费专家。同一本地模型一次只跑一个推理请求；长上下文压缩期间请勿再开同模型重任务。" : "独立窗口与任务库。多个模型可以同时工作；更改配置后需重新启动对应模型窗口。").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if model.id != "official" { Button(model.archived ? "恢复模型" : "归档") { Task { await library.archive() } } }
                Spacer()
                Button("检查连接") { Task { await library.perform("check") } }.disabled(!model.ready || model.archived)
                Button("真实验证") { Task { await library.perform("probe") } }.disabled(!model.ready || model.archived || model.protocol == "oauth").help("发送短测试请求，消耗少量供应商额度")
                Button("启动 Codex") { Task { await library.perform("launch") } }.buttonStyle(.borderedProminent).disabled(!model.ready || model.archived)
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

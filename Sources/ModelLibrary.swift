import AppKit
import CoreGraphics
import SwiftUI

struct ManagedModel: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var vendor: String
    var endpoint: String
    var `protocol`: String
    var model: String
    var notes: String
    var docs: String
    var credentialID: String
    var noKey: Bool
    var archived: Bool
    var switchable: Bool?
    var fallback: String?
    var hidden: Bool?
    var contextWindow: Int
    var hasKey: Bool?
    var verifiedAt: String?
    var ready: Bool { !model.isEmpty && (noKey || hasKey == true || `protocol` == "oauth") }
    var status: String { archived ? "已归档" : (verifiedAt != nil ? "推理已验证" : (ready ? "待验证" : "待配置")) }
    var icon: String { `protocol` == "oauth" ? "sparkles" : (noKey ? "desktopcomputer" : "network") }
    var color: Color { `protocol` == "oauth" ? .blue : (noKey ? .green : .indigo) }
    static func new() -> ManagedModel {
        ManagedModel(id: "model-" + UUID().uuidString.lowercased(), name: "", vendor: "自定义", endpoint: "https://api.deepseek.com/v1", protocol: "responses", model: "", notes: "", docs: "", credentialID: "", noKey: false, archived: false, contextWindow: 128000)
    }
}

struct ProviderTemplate: Decodable, Identifiable {
    let id: String
    let name: String
    let endpoint: String
    let `protocol`: String
    let model: String
    let docs: String
    let noKey: Bool?
}

struct SwitchableModel: Decodable, Identifiable, Hashable {
    let id: String
    let slug: String
    let name: String
    let model: String
    let vendor: String
    let `protocol`: String
}

struct ProductResponse: Decodable {
    var ok: Bool
    var message: String?
    var revision: Int?
    var routes: [ManagedModel]?
    var templates: [ProviderTemplate]?
    var models: [String]?
    var exportData: String?
    var expertPolicy: ExpertPolicy?
    var expertUsage: ExpertUsage?
    var localStatus: LocalRuntimeStatus?
    var answer: String?
    var switchModels: [SwitchableModel]?
    var routerRunning: Bool?
    var windows: [WorkWindow]?
    var orphans: [WorkWindow]?
    var window: WorkWindow?
    var pid: Int?
    var disk: DiskUsage?
    var cleanupPlan: DiskPlan?
    var cleanup: CleanupResult?
    var diskPolicy: DiskPolicy?
}

// 磁盘占用与可回收量。助手目录里同一批会话会在每个窗口各存一份，是这套多窗口机制最容易失控的地方。
struct DiskUsage: Decodable {
    var totalBytes: Int64
    var reclaimable: Int64
    var freeDiskPercent: Double
    var freeDiskBytes: Int64?
    var perWindow: [DiskWindow]?
}

struct DiskWindow: Decodable, Hashable {
    var id: String
    var running: Bool?
    var threads: Int?
    var copies: Int?
    var originals: Int?
    var reclaimBytes: Int64?
    var cacheBytes: Int64?
    var pendingBytes: Int64?
    var pendingCount: Int?
    var copyBytes: Int64?
    var bytes: Int64?
    var reason: String?
}

struct DiskPlan: Decodable {
    var reclaimBytes: Int64
    var staleDays: Int?
    var items: DiskPlanItems?
    var caches: DiskPlanItems?
    var keepOriginals: DiskPlanKeep?
    var skipped: [DiskWindow]?
}

struct DiskPlanItems: Decodable {
    var count: Int
    var bytes: Int64
}

struct DiskPlanKeep: Decodable {
    var count: Int
    var bytes: Int64
}

struct CleanupResult: Decodable {
    var deletedFiles: Int?
    var deletedThreads: Int?
    var deletedCacheDirs: Int?
    var freedBytes: Int64?
    var backupManifest: String?
}

// 磁盘策略：窗口启动前自动清理不重要副本、顺手清浏览器缓存。两个开关都可由用户关掉。
struct DiskPolicy: Decodable {
    var revision: Int?
    var autoCleanupOnLaunch: Bool?
    var pruneBrowserCache: Bool?
}

func humanBytes(_ bytes: Int64?) -> String {
    var size = Double(bytes ?? 0)
    for unit in ["B", "KB", "MB", "GB", "TB"] {
        if size < 1024 || unit == "TB" { return unit == "B" ? "\(Int(size)) B" : String(format: "%.1f %@", size, unit) }
        size /= 1024
    }
    return "\(Int(size)) B"
}

// 每个窗口有自己的一份 CODEX_HOME 与浏览器数据目录，可以同时开多个，各自在 Codex 里换模型。
struct WorkWindow: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    var initialModel: String?
    var createdAt: String?
    var legacy: Bool?
    var running: Bool?
    var pid: Int?
    var homePath: String?
}

struct LocalRuntimeStatus: Decodable {
    let preferredLocal: String
    let localCallers: [String]
    let runningInstances: [String]
    let loadedModels: [String]
    let message: String
}

@MainActor
final class LibraryViewModel: ObservableObject {
    @Published var models: [ManagedModel] = []
    @Published var templates: [ProviderTemplate] = []
    // 不预设某个本地模型：默认选官方入口，专家策略里配了什么就显示什么，取不到就显示「未配置」。
    @Published var selectedID = ""
    @Published var search = ""
    @Published var showArchived = false
    @Published var showHidden = false
    @Published var busy = false
    @Published var message = "正在读取模型库…"
    @Published var success: Bool?
    @Published var discovered: [String] = []
    @Published var discoveryFilter = ""
    @Published var showDiscovery = false
    @Published var showDiagnostics = false
    @Published var diagnostics = ""
    @Published var expertPolicy: ExpertPolicy?
    @Published var expertUsage: ExpertUsage?
    @Published var localStatus: LocalRuntimeStatus?
    @Published var showExpert = false
    @Published var switchModels: [SwitchableModel] = []
    @Published var routerRunning = false
    @Published var showSwitch = false
    @Published var windows: [WorkWindow] = []
    @Published var orphans: [WorkWindow] = []
    @Published var newWindowModel = ""
    @Published var disk: DiskUsage?
    @Published var diskPlan: DiskPlan?
    @Published var diskPolicy: DiskPolicy?
    @Published var showCleanupConfirm = false
    private var revision = 0
    var selected: ManagedModel? { models.first { $0.id == selectedID } }
    var visible: [ManagedModel] {
        // 排序优先级只用来把常用条目排在前面：官方、DeepSeek 官方接口，然后是专家策略指定的本地入口。
        // 本地入口不再有硬编码默认值——策略里没有就用空串（排序里自然落到后面），不会再把某个本地模型当成默认主力。
        let priority = ["official", "deepseek-flash", preferredLocalID] + Self.localRouteIDs
        return models.filter { $0.archived == showArchived && (showHidden || $0.hidden != true) && (search.isEmpty || "\($0.name) \($0.vendor) \($0.model)".localizedCaseInsensitiveContains(search)) }.sorted {
            let first = priority.firstIndex(of: $0.id) ?? 100
            let second = priority.firstIndex(of: $1.id) ?? 100
            return first == second ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : first < second
        }
    }
    var readyCount: Int { models.filter { $0.ready && !$0.archived }.count }
    var preferredLocalID: String { expertPolicy?.preferredLocal ?? localStatus?.preferredLocal ?? "" }
    var canLaunchPreferredLocal: Bool { !preferredLocalID.isEmpty && models.contains { $0.id == preferredLocalID && $0.ready && !$0.archived } }
    var preferredLocalName: String { preferredLocalID.isEmpty ? "未配置" : (canLaunchPreferredLocal ? (models.first { $0.id == preferredLocalID }?.name ?? "未配置") : "已停用") }
    // 本地入口只有这两条路由；这是路由身份，不是「默认把本地当主力」——默认主力由专家策略决定。
    static let localRouteIDs = ["s5090-ornith", "s5090-qwen"]
    func isLocal(_ model: ManagedModel) -> Bool { Self.localRouteIDs.contains(model.id) }
    func isRunning(_ model: ManagedModel) -> Bool { localStatus?.runningInstances.contains(model.id) == true }
    func isLoaded(_ model: ManagedModel) -> Bool { localStatus?.loadedModels.contains(model.model) == true }

    // 管道读取结果：子进程的输出必须边跑边收，只等不读会在输出超过管道缓冲时两边一起卡死。
    private final class PipeCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Data?
        func store(_ data: Data) { lock.lock(); value = data; lock.unlock() }
        func take() -> Data? { lock.lock(); defer { lock.unlock() }; return value }
    }

    // 带超时的调用：CLI 万一卡住也要把控制权还给界面。
    // 否则 busy 会一直是 true，所有按钮永久变灰——表现就是「只能开一个 Codex，点新建窗口没反应」。
    func call(_ arguments: [String], input: Data? = nil, timeout: TimeInterval = 180) async -> ProductResponse {
        await Task.detached {
            guard let resources = Bundle.main.resourceURL else { return ProductResponse(ok: false, message: "应用资源缺失，请重新安装") }
            let process = Process()
            let output = Pipe()
            let standardInput = Pipe()
            let bundledNode = resources.appendingPathComponent("node")
            process.executableURL = FileManager.default.isExecutableFile(atPath: bundledNode.path) ? bundledNode : URL(fileURLWithPath: "/opt/homebrew/bin/node")
            process.arguments = [resources.appendingPathComponent("runtime/product-cli.mjs").path] + arguments
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = standardInput
            do {
                try process.run()
                if let input { try standardInput.fileHandleForWriting.write(contentsOf: input) }
                try standardInput.fileHandleForWriting.close()
                let collected = PipeCollector()
                DispatchQueue.global(qos: .userInitiated).async {
                    collected.store(output.fileHandleForReading.readDataToEndOfFile())
                }
                let deadline = Date().addingTimeInterval(timeout)
                while collected.take() == nil, Date() < deadline {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                if collected.take() == nil, process.isRunning {
                    process.terminate()
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    return ProductResponse(ok: false, message: "操作超时：\(arguments.first ?? "命令") 超过 \(Int(timeout)) 秒没有返回，已中止。请点「刷新状态」重试。")
                }
                // 进程已经退出：等读取线程收完最后一段输出（通常是毫秒级）。
                let drainDeadline = Date().addingTimeInterval(3)
                while collected.take() == nil, Date() < drainDeadline {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                guard let data = collected.take() else { return ProductResponse(ok: false, message: "操作失败：没有拿到结果，请点「刷新状态」重试") }
                process.waitUntilExit()
                return try JSONDecoder().decode(ProductResponse.self, from: data)
            } catch { return ProductResponse(ok: false, message: "操作失败：\(error.localizedDescription)") }
        }.value
    }

    func accept(_ response: ProductResponse) {
        if let routes = response.routes { models = routes }
        if let values = response.templates { templates = values }
        if let value = response.revision { revision = value }
        if let value = response.message { message = value }
        if let policy = response.expertPolicy { expertPolicy = policy }
        if let usage = response.expertUsage { expertUsage = usage }
        if let status = response.localStatus { localStatus = status }
        if let values = response.switchModels { switchModels = values }
        if let value = response.routerRunning { routerRunning = value }
        if let values = response.windows { windows = values }
        if let values = response.orphans { orphans = values }
        if let value = response.disk { disk = value }
        if let value = response.cleanupPlan { diskPlan = value }
        if let value = response.diskPolicy { diskPolicy = value }
        success = response.ok
    }

    // 助手目录里同一批会话在每个窗口各存一份，堆积起来能到几十 GB，所以要能看见、能清。
    func refreshDisk() async {
        busy = true
        let response = await call(["disk-usage"], timeout: 600)
        accept(response)
        busy = false
    }

    // 清理会删会话副本，只在这里、只在确认后执行；官方库和窗口独有原件都不动。
    func applyCleanup() async {
        busy = true
        success = nil
        message = "正在清理副本和浏览器缓存（窗口自己的任务库会收缩，可能要一两分钟）…"
        // VACUUM 在大库上比较慢，给足时间。
        let response = await call(["cleanup-apply", "--confirm"], timeout: 3600)
        accept(response)
        busy = false
    }

    // 打开/关闭「窗口启动前自动清理」。关掉后只在手动点「清理」时才删，范围不变。
    func setAutoCleanup(_ enabled: Bool) async {
        busy = true
        success = nil
        let current = diskPolicy ?? DiskPolicy(revision: nil, autoCleanupOnLaunch: true, pruneBrowserCache: true)
        let body: [String: Any] = [
            "revision": current.revision ?? 1,
            "autoCleanupOnLaunch": enabled,
            "pruneBrowserCache": current.pruneBrowserCache ?? true,
        ]
        let data = try? JSONSerialization.data(withJSONObject: body)
        let response = await call(["set-disk-policy"], input: data, timeout: 60)
        accept(response)
        busy = false
    }

    var cleanupPrompt: String {
        let plan = diskPlan
        let count = plan?.items?.count ?? 0
        let caches = plan?.caches?.count ?? 0
        let bytes = humanBytes(plan?.reclaimBytes ?? disk?.reclaimable)
        let keep = plan?.keepOriginals?.count ?? 0
        let parts = [
            count > 0 ? "\(count) 个会话副本" : nil,
            caches > 0 ? "\(caches) 个浏览器缓存目录" : nil,
        ].compactMap { $0 }.joined(separator: "、")
        return "将删除 \(parts.isEmpty ? "没有可清的内容" : parts)、释放 \(bytes)；官方库和 \(keep) 条窗口独有对话不受影响。被清掉的对话仍可用「导入全部」从官方库取回，缓存会在下次打开时自动重建。"
    }

    // 目录超过 20 GB 或系统剩余不足 15% 时提醒一次。
    var diskNeedsAttention: Bool {
        guard let disk else { return false }
        return disk.totalBytes >= 20 * 1024 * 1024 * 1024 || disk.freeDiskPercent < 15
    }

    func refresh() async {
        busy = true
        let gateway = await call(["start-gateway"])
        let response = await call(["library"])
        accept(response)
        // 没选过（或原先选中的条目已经不在库里）就落到官方入口，不再硬编码某个本地模型。
        if selectedID.isEmpty || !models.contains(where: { $0.id == selectedID }) {
            selectedID = models.contains { $0.id == "official" } ? "official" : (models.first?.id ?? "")
        }
        if selected?.archived == true && !showArchived { selectedID = "official" }
        if response.ok { message = gateway.ok ? "模型库已就绪。选择模型，配置密钥并验证后启动。" : (gateway.message ?? "模型网关未启动"); success = gateway.ok ? nil : false }
        busy = false
    }

    func select(_ id: String) {
        selectedID = id
        success = nil
        message = "连接检查不消耗推理额度；真实验证会发送一条短测试请求。"
    }

    func openExpert() async {
        busy = true
        let response = await call(["expert-status"])
        accept(response)
        showExpert = response.ok
        busy = false
    }

    func openSwitch() async {
        busy = true
        let response = await call(["switch-status"])
        accept(response)
        if newWindowModel.isEmpty, let first = response.switchModels?.first { newWindowModel = first.id }
        showSwitch = response.ok
        busy = false
    }

    var runningWindowCount: Int { windows.filter { $0.running == true }.count }
    var legacyWindow: WorkWindow? { windows.first { $0.id == "router" } }
    func windowName(for modelID: String) -> String? { windows.first { $0.initialModel == modelID }?.name }

    // 新建一个独立窗口：它自带一份 CODEX_HOME 与浏览器数据目录，可以和其它窗口同时运行、各自换模型。
    func newWindow(initial: String = "") async {
        busy = true
        success = nil
        message = "正在新建可切换窗口（第一次启动需要几秒）…"
        let response = await call(["new-window", initial])
        accept(response)
        raiseWindowIfNeeded(response.pid)
        busy = false
    }

    // 打开已有窗口。窗口正在运行时只提示，不会重复启动；起始模型用窗口记住的那个。
    func openWindow(_ id: String) async {
        busy = true
        success = nil
        message = "正在打开窗口…"
        let response = await call(["open-window", id])
        accept(response)
        // 已经在跑的窗口不会有新 pid，但同样应该被提到最前。
        raiseWindowIfNeeded(response.pid ?? response.window?.pid ?? windows.first { $0.id == id }?.pid)
        busy = false
    }

    // 新窗口可能开在当前窗口后面，看起来像「点了没反应」。用进程号把它提到最前。
    private func raiseWindowIfNeeded(_ pid: Int?) {
        guard let pid, pid > 0, let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return }
        app.unhide()
        app.activate(options: [.activateAllWindows])
    }

    // 「置前」：把已经开着但被最小化、被别的窗口压住、或丢在别的桌面上的 Codex 找回来。
    // 多开时最容易出现的错觉就是「只能开一个」——其实其它窗口都开着，只是看不见。
    func bringWindowToFront(_ id: String) async {
        success = nil
        let pid = windows.first { $0.id == id }?.pid ?? 0
        guard pid > 0, let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            message = "这个窗口没有在运行，点「打开」启动它。"
            success = false
            return
        }
        app.unhide()
        app.activate(options: [.activateAllWindows])
        // 激活后等一下再数一下屏幕上有没有它的窗口，避免「命令成功但用户还是看不到」。
        var visible = visibleWindowCount(pid: pid)
        for _ in 0..<8 where visible == 0 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            visible = visibleWindowCount(pid: pid)
        }
        let frontmost = app.isActive
        let name = windows.first { $0.id == id }?.name ?? id
        // 刷新列表会重写提示语，所以先刷新再写结论。
        await openSwitch()
        if visible > 0 || frontmost {
            message = "已把「\(name)」切到最前。"
            success = true
        } else {
            message = "「\(name)」的进程还在（PID \(pid)），但窗口当前不在屏幕上：多半被最小化了。在 Dock 的 Codex 图标上点一下即可展开。"
            success = false
        }
    }

    // 屏幕上真正可见的窗口数；只统计普通层（layer 0）的窗口。
    private func visibleWindowCount(pid: Int) -> Int {
        guard pid > 0, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return 0 }
        return list.filter { entry in
            (entry[kCGWindowOwnerPID as String] as? Int) == pid && ((entry[kCGWindowLayer as String] as? Int) ?? 1) == 0
        }.count
    }

    // 接管在跑但没登记进注册表的窗口：并发建窗丢过记录时留下的进程，接管后就能在列表里关闭或重开。
    func adoptOrphans() async {
        busy = true
        success = nil
        message = "正在接管未登记的窗口…"
        accept(await call(["adopt-window", "all"]))
        busy = false
    }

    func renameWindow(_ id: String, to name: String) async {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { message = "请输入窗口名称"; success = false; return }
        busy = true
        success = nil
        accept(await call(["rename-window", id, clean]))
        busy = false
    }

    func closeWindow(_ id: String) async {
        busy = true
        success = nil
        message = "正在关闭窗口…"
        accept(await call(["close-window", id]))
        busy = false
    }

    func deleteWindow(_ id: String) async {
        busy = true
        success = nil
        message = "正在删除窗口…"
        accept(await call(["delete-window", id]))
        busy = false
    }

    func openWorkWindow() async { await openWindow("router") }

    func toggleHidden() async {
        showHidden.toggle()
    }

    func importHistory(_ target: String) async {
        busy = true
        success = nil
        message = target == "shared" ? "正在从官方任务库导入会话，较大时需等待…" : "正在导入已有会话，较大的任务库需要一些时间…"
        accept(await call(["import-history", target]))
        busy = false
    }

    func callRepairAndRefreshDiagnostics() async {
        busy = true
        success = nil
        message = "正在修复工作窗口分组…"
        accept(await call(["repair-work-window"]))
        let diagnosis = await call(["diagnostics"])
        if diagnosis.ok { diagnostics = diagnosis.message ?? "" }
        busy = false
    }

    func launchPreferredLocal() async {
        guard canLaunchPreferredLocal else { message = "本地主力已停用，请选择其他可用模型"; success = false; return }
        selectedID = preferredLocalID
        await perform("launch")
    }

    func perform(_ operation: String) async {
        let id = selectedID
        busy = true
        success = nil
        message = operation == "continue" ? "正在复制原会话和索引，保留官方原件；较大任务库需要一些时间…" : operation == "probe" ? "正在执行真实推理验证，最长 90 秒…" : "正在处理…"
        let response = await call([operation, id])
        accept(response)
        if operation == "discover", response.ok {
            discovered = response.models ?? []
            discoveryFilter = ""
            showDiscovery = true
        }
        if operation == "diagnostics", response.ok { diagnostics = response.message ?? ""; showDiagnostics = true }
        busy = false
    }

    func save(_ model: ManagedModel, key: String = "", clearKey: Bool = false) async -> Bool {
        busy = true
        do {
            let routeObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(model))
            let data = try JSONSerialization.data(withJSONObject: ["route": routeObject, "revision": revision, "key": key, "clearKey": clearKey])
            let response = await call(["save"], input: data)
            accept(response)
            busy = false
            if response.ok { selectedID = model.id }
            return response.ok
        } catch { message = error.localizedDescription; success = false; busy = false; return false }
    }

    func archive() async {
        guard let model = selected else { return }
        busy = true
        let data = try? JSONSerialization.data(withJSONObject: ["revision": revision, "archived": !model.archived])
        accept(await call(["archive", model.id], input: data))
        if success == true { selectedID = "official"; showArchived = false }
        busy = false
    }

    func exportLibrary() async {
        busy = true
        let response = await call(["export"])
        accept(response)
        if let content = response.exportData, response.ok {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "Codex-Models.json"
            panel.message = "仅导出模型设置，不含密钥、登录凭据或任务记录。"
            if panel.runModal() == .OK, let url = panel.url {
                do { try content.write(to: url, atomically: true, encoding: .utf8); message = "模型配置已导出（不含密钥）" }
                catch { message = error.localizedDescription; success = false }
            }
        }
        busy = false
    }

    func importLibrary() async {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "作为新模型导入，不覆盖现有配置；导入后需重新配置 Key。"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            if ((attributes[.size] as? NSNumber)?.intValue ?? 0) > 4 * 1024 * 1024 { throw CocoaError(.fileReadTooLarge) }
            let content = try String(contentsOf: url, encoding: .utf8)
            let data = try JSONSerialization.data(withJSONObject: ["data": content, "revision": revision])
            accept(await call(["import"], input: data))
        } catch { message = error.localizedDescription; success = false }
        busy = false
    }
}

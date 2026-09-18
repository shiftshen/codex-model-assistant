import AppKit
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
    var window: WorkWindow?
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
    @Published var selectedID = "s5090-ornith"
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
    @Published var newWindowModel = ""
    private var revision = 0
    var selected: ManagedModel? { models.first { $0.id == selectedID } }
    var visible: [ManagedModel] {
        let priority = ["official", "deepseek-flash", expertPolicy?.preferredLocal ?? "s5090-ornith", "s5090-ornith", "s5090-qwen"]
        return models.filter { $0.archived == showArchived && (showHidden || $0.hidden != true) && (search.isEmpty || "\($0.name) \($0.vendor) \($0.model)".localizedCaseInsensitiveContains(search)) }.sorted {
            let first = priority.firstIndex(of: $0.id) ?? 100
            let second = priority.firstIndex(of: $1.id) ?? 100
            return first == second ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : first < second
        }
    }
    var readyCount: Int { models.filter { $0.ready && !$0.archived }.count }
    var preferredLocalID: String { expertPolicy?.preferredLocal ?? localStatus?.preferredLocal ?? "s5090-ornith" }
    var canLaunchPreferredLocal: Bool { models.contains { $0.id == preferredLocalID && $0.ready && !$0.archived } }
    var preferredLocalName: String { canLaunchPreferredLocal ? (models.first { $0.id == preferredLocalID }?.name ?? "未配置") : "已停用" }
    func isLocal(_ model: ManagedModel) -> Bool { ["s5090-ornith", "s5090-qwen"].contains(model.id) }
    func isRunning(_ model: ManagedModel) -> Bool { localStatus?.runningInstances.contains(model.id) == true }
    func isLoaded(_ model: ManagedModel) -> Bool { localStatus?.loadedModels.contains(model.model) == true }

    func call(_ arguments: [String], input: Data? = nil) async -> ProductResponse {
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
                let data = output.fileHandleForReading.readDataToEndOfFile()
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
        success = response.ok
    }

    func refresh() async {
        busy = true
        let gateway = await call(["start-gateway"])
        let response = await call(["library"])
        accept(response)
        if selectedID == "s5090-ornith", let policy = response.expertPolicy { selectedID = policy.preferredLocal }
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
        accept(await call(["new-window", initial]))
        busy = false
    }

    // 打开已有窗口。窗口正在运行时只提示，不会重复启动；起始模型用窗口记住的那个。
    func openWindow(_ id: String) async {
        busy = true
        success = nil
        message = "正在打开窗口…"
        accept(await call(["open-window", id]))
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

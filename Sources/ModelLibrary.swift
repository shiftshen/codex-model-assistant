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
    private var revision = 0
    var selected: ManagedModel? { models.first { $0.id == selectedID } }
    var visible: [ManagedModel] {
        let priority = [expertPolicy?.preferredLocal ?? "s5090-ornith", "s5090-ornith", "s5090-qwen", "official"]
        return models.filter { $0.archived == showArchived && (search.isEmpty || "\($0.name) \($0.vendor) \($0.model)".localizedCaseInsensitiveContains(search)) }.sorted {
            let first = priority.firstIndex(of: $0.id) ?? 100
            let second = priority.firstIndex(of: $1.id) ?? 100
            return first == second ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : first < second
        }
    }
    var readyCount: Int { models.filter { $0.ready && !$0.archived }.count }
    var preferredLocalID: String { localStatus?.preferredLocal ?? expertPolicy?.preferredLocal ?? "s5090-ornith" }
    var preferredLocalName: String { models.first { $0.id == preferredLocalID }?.name ?? (preferredLocalID == "s5090-qwen" ? "Qwen3.8 27B · 5090" : "Ornith 1.5 35B · 5090") }
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
        success = response.ok
    }

    func refresh() async {
        busy = true
        let gateway = await call(["start-gateway"])
        let response = await call(["library"])
        accept(response)
        if selectedID == "s5090-ornith", let policy = response.expertPolicy { selectedID = policy.preferredLocal }
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

    func launchPreferredLocal() async {
        selectedID = preferredLocalID
        await perform("launch")
    }

    func perform(_ operation: String) async {
        let id = selectedID
        busy = true
        success = nil
        message = operation == "probe" ? "正在执行真实推理验证，最长 90 秒…" : "正在处理…"
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

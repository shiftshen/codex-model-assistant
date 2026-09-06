import SwiftUI

struct ExpertPolicy: Codable {
    var revision: Int
    var mode: String
    var preferredLocal: String
    var expertRoute: String
    var dailyCalls: Int
    var callerDailyCalls: Int
    var cooldownSeconds: Int
    var maxInputChars: Int
    var maxOutputTokens: Int
}

struct ExpertRecord: Decodable, Identifiable {
    let id: String
    let caller: String
    let expert: String
    let model: String
    let reason: String
    let createdMs: Double
    let status: String
    let inputChars: Int
    let inputTokens: Int?
    let outputTokens: Int?
}

struct ExpertUsage: Decodable {
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let resetsAt: String
    let records: [ExpertRecord]
}

struct ExpertSettingsView: View {
    @ObservedObject var library: LibraryViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ExpertPolicy(revision: 1, mode: "on_demand", preferredLocal: "s5090-ornith", expertRoute: "deepseek-flash", dailyCalls: 6, callerDailyCalls: 3, cooldownSeconds: 90, maxInputChars: 12000, maxOutputTokens: 1500)
    @State private var tab = "policy"
    @State private var question = ""
    @State private var context = ""
    @State private var answer = ""
    @State private var feedback = ""
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("本地主力，专家按需协助").font(.title2.bold())
            Text("Ornith / Qwen 负责开发和测试，付费模型只提供针对性建议。").font(.callout).foregroundStyle(.secondary)
            Picker("专家面板", selection: $tab) {
                Text("策略与限额").tag("policy")
                Text("手动请专家").tag("manual")
                Text("调用记录").tag("history")
            }.pickerStyle(.segmented).disabled(library.busy)
            if tab == "policy" { policyForm }
            else if tab == "manual" { manualForm }
            else { history }
            if !feedback.isEmpty {
                Text(feedback).font(.callout).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true)
            }
            if library.busy { ProgressView("处理中，请勿重复提交…").controlSize(.small) }
            HStack {
                if let usage = library.expertUsage { Text("今日已请求 \(usage.calls) 次 · 输入 \(usage.inputTokens) / 输出 \(usage.outputTokens) tokens").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.cancelAction).disabled(library.busy)
            }
        }
        .padding(24).frame(width: 690, height: 680)
        .onAppear { if let policy = library.expertPolicy { draft = policy } }
        .interactiveDismissDisabled(library.busy)
    }

    private var policyForm: some View {
        Form {
            Picker("默认本地主力", selection: $draft.preferredLocal) {
                Text("Ornith 1.5 · 5090").tag("s5090-ornith")
                Text("Qwen3.8 · 5090").tag("s5090-qwen")
            }
            Picker("专家调用模式", selection: $draft.mode) {
                Text("按需调用（本地模型自主判断）").tag("on_demand")
                Text("仅在本面板手动调用").tag("manual_only")
                Text("停用付费专家").tag("disabled")
            }
            Picker("付费专家", selection: $draft.expertRoute) {
                ForEach(library.models.filter { !$0.noKey && $0.protocol != "oauth" && !$0.archived && !$0.model.isEmpty && $0.hasKey == true }) { model in Text(model.name).tag(model.id) }
            }
            Stepper("每日总调用上限：\(draft.dailyCalls)", value: $draft.dailyCalls, in: 1...100)
            Stepper("每个本地主力每日上限：\(draft.callerDailyCalls)", value: $draft.callerDailyCalls, in: 1...50)
            Stepper("两次咨询间隔：\(draft.cooldownSeconds) 秒", value: $draft.cooldownSeconds, in: 0...3600, step: 30)
            Stepper("每次输入最多 \(draft.maxInputChars) 字符", value: $draft.maxInputChars, in: 500...24000, step: 500)
            Stepper("每次输出最多 \(draft.maxOutputTokens) tokens", value: $draft.maxOutputTokens, in: 128...4096, step: 128)
            Text("按 UTC 日期重置。请求前占用额度，失败/超时也计入次数且不自动重试。重复问题可使用缓存。次数和长度限制不等于精确金额预算。").font(.caption).foregroundStyle(.secondary)
            Button("保存专家策略") {
                Task {
                    library.busy = true
                    let response = await library.call(["expert-save"], input: try? JSONEncoder().encode(draft))
                    library.accept(response)
                    if let policy = response.expertPolicy { draft = policy }
                    feedback = response.message ?? ""
                    failed = !response.ok
                    library.busy = false
                }
            }.buttonStyle(.borderedProminent)
        }.formStyle(.grouped).disabled(library.busy)
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("使用已保存的专家策略和额度。仅发送下方输入；不会附带整个任务历史。").font(.caption).foregroundStyle(.secondary)
            TextField("一个具体问题（至少 12 字符）", text: $question).textFieldStyle(.roundedBorder)
            Text("必要的代码片段 / 错误 / 已尝试方法").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $context).font(.system(.body, design: .monospaced)).frame(height: 110).border(Color.secondary.opacity(0.2))
            Button("发送一次专家咨询") {
                Task {
                    library.busy = true
                    feedback = "专家正在分析，最长 60 秒…"
                    failed = false
                    let payload: [String: Any] = ["reason": "user_requested", "question": question, "context": context, "attempts": [], "evidence": "用户通过助手面板明确发起咨询"]
                    let response = await library.call(["expert-consult", library.expertPolicy?.preferredLocal ?? "s5090-ornith"], input: try? JSONSerialization.data(withJSONObject: payload))
                    library.accept(response)
                    answer = response.answer ?? ""
                    feedback = response.message ?? ""
                    failed = !response.ok
                    library.busy = false
                }
            }.buttonStyle(.borderedProminent).disabled(library.busy || question.trimmingCharacters(in: .whitespacesAndNewlines).count < 12)
            ScrollView { Text(answer.isEmpty ? "专家的建议将在这里显示。请交给本地主力执行并验证。" : answer).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                .padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("仅记录调用元数据与用量，不记录问题正文。失败请求也占额度；缓存命中不发起新请求。").font(.caption).foregroundStyle(.secondary)
            List(library.expertUsage?.records ?? []) { record in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("\(record.caller == "s5090-ornith" ? "Ornith" : "Qwen") → \(record.model)").font(.callout.bold())
                        Spacer()
                        Text(record.status == "completed" ? "已返回" : (record.status == "pending" ? "进行中 / 待核实" : "失败")).font(.caption)
                    }
                    Text(Date(timeIntervalSince1970: record.createdMs / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
                    Text("输入 \(record.inputChars) 字符 · 输出 \(record.outputTokens.map(String.init) ?? "未知") tokens · \(record.reason)").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 5)
            }
            Button("刷新调用记录") {
                Task { library.busy = true; library.accept(await library.call(["expert-status"])); library.busy = false }
            }.disabled(library.busy)
        }
    }
}

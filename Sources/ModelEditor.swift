import SwiftUI

struct ModelEditor: View {
    @ObservedObject var library: LibraryViewModel
    @State var draft: ManagedModel
    let isNew: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var templateID = "custom"
    @State private var key = ""
    @State private var clearKey = false
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(isNew ? "添加模型" : "编辑模型").font(.title2.bold())
                    Text("配置保存在本机，密钥不会包含在导出文件中。").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "slider.horizontal.3").font(.title).foregroundStyle(.tint)
            }
            Form {
                if isNew {
                    Picker("供应商模板", selection: $templateID) {
                        Text("自定义兼容服务").tag("custom")
                        ForEach(library.templates.filter { $0.id != "custom" }) { template in Text(template.name).tag(template.id) }
                    }
                    .onChange(of: templateID) { _, value in
                        guard let template = library.templates.first(where: { $0.id == value }) else { return }
                        draft.name = template.name
                        draft.vendor = template.name
                        draft.endpoint = template.endpoint
                        draft.protocol = template.protocol
                        draft.model = template.model
                        draft.docs = template.docs
                        draft.noKey = template.noKey ?? false
                        draft.credentialID = template.id == "custom" ? draft.id : template.id
                    }
                }
                TextField("显示名称", text: $draft.name)
                TextField("供应商", text: $draft.vendor)
                if draft.protocol == "oauth" {
                    Picker("官方模型", selection: $draft.model) {
                        ForEach(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"], id: \.self) { model in Text(model).tag(model) }
                    }
                } else {
                    TextField("模型 ID", text: $draft.model, prompt: Text("可先保存，再使用「发现模型」选择"))
                }
                if draft.protocol != "oauth" {
                    TextField("API 地址", text: $draft.endpoint)
                    Picker("接口格式", selection: $draft.protocol) {
                        Text("Responses API").tag("responses")
                        Text("Chat Completions").tag("chat")
                        Text("Anthropic Messages").tag("anthropic")
                    }
                    Toggle("无需 API Key（本地服务）", isOn: $draft.noKey)
                    if !draft.noKey {
                        SecureField(draft.hasKey == true ? "新 API Key（留空保留）" : "API Key", text: $key).textContentType(.password)
                        Text("同供应商模板默认共用 Key。修改 API 地址后需要重新输入 Key。").font(.caption).foregroundStyle(.secondary)
                        if draft.hasKey == true { Toggle("清除已保存的 Key", isOn: $clearKey).tint(.red) }
                    }
                } else {
                    Text("使用现有 ChatGPT 登录；API Key 不适用于此入口。").font(.callout).foregroundStyle(.secondary)
                }
                TextField("上下文 Token 数", value: $draft.contextWindow, format: .number.grouping(.never))
                TextField("备注", text: $draft.notes)
            }
            .formStyle(.grouped)
            .frame(minHeight: 350)
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.callout).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Text("修改后请重新验证连接。").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(library.busy ? "保存中…" : "保存模型") {
                    Task {
                        if await library.save(draft, key: key, clearKey: clearKey) { key = ""; dismiss() }
                        else { error = library.message }
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(library.busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 610, height: 650)
        .interactiveDismissDisabled(library.busy)
    }
}

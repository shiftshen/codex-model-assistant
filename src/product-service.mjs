import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelStore, atomicJSON, validateRoute } from "./model-store.mjs";
import { gatewayURL, upstream, limitedJSON } from "./model-gateway.mjs";
import { attachExpertConfig, localExpertInstructions } from "./local-expert-config.mjs";
import { localCallers, readExpertPolicy } from "./expert-policy.mjs";

const sharedHome = path.join(os.homedir(), ".codex");
const appBinary = "/Applications/Codex.app/Contents/MacOS/ChatGPT";
const execFileAsync = promisify(execFile);

export function renderProductConfig(source, route, catalogPath) {
  const clean = source.replace(/\n?# BEGIN CODEX MODEL ASSISTANT V2[\s\S]*?# END CODEX MODEL ASSISTANT V2\n?/g, "\n");
  const lines = clean.split(/\r?\n/);
  const section = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = (section === -1 ? lines : lines.slice(0, section)).filter((line) => !/^\s*(model|model_provider|model_catalog_json|service_tier|profile)\s*=/.test(line));
  const provider = `cma_${route.id.replaceAll("-", "_")}`;
  const routing = [`model = ${JSON.stringify(route.model)}`];
  if (route.protocol !== "oauth") routing.push(`model_provider = "${provider}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`);
  const block = route.protocol === "oauth" ? "" : `# BEGIN CODEX MODEL ASSISTANT V2\n[model_providers.${provider}]\nname = ${JSON.stringify(route.name)}\nbase_url = ${JSON.stringify(`${gatewayURL}/routes/${route.id}/v1`)}\nenv_key = "CMA_ROUTE_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\n# END CODEX MODEL ASSISTANT V2`;
  return [top.join("\n").trim(), routing.join("\n"), section === -1 ? "" : lines.slice(section).join("\n").trim(), block].filter(Boolean).join("\n\n") + "\n";
}

function catalog(route) {
  return { models: [{ slug: route.model, display_name: route.name, description: route.vendor, default_reasoning_level: "medium", supported_reasoning_levels: [], shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 1, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 }, context_window: route.contextWindow, effective_context_window_percent: 90, experimental_supported_tools: [], input_modalities: ["text"], supports_search_tool: false, supports_parallel_tool_calls: true, base_instructions: "" }] };
}

export class ProductService {
  constructor(store = new ModelStore()) { this.store = store; }
  async localRuntimeStatus() {
    const policy = await readExpertPolicy(this.store);
    const instancesRoot = path.join(this.store.root, "instances-v2");
    let runningInstances = [];
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-axo", "args"], { maxBuffer: 1024 * 1024 });
      const escapedRoot = instancesRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`--user-data-dir=${escapedRoot}/([^/]+)/browser-data`, "g");
      runningInstances = [...new Set([...stdout.matchAll(pattern)].map((match) => match[1]))].sort();
    } catch { }
    let loadedModels = [];
    try {
      const response = await fetch("http://127.0.0.1:11434/api/ps", { signal: AbortSignal.timeout(1500), redirect: "error" });
      const data = await response.json();
      loadedModels = Array.isArray(data.models) ? data.models.map((model) => model.name).filter(Boolean) : [];
    } catch { }
    return {
      preferredLocal: policy.preferredLocal,
      localCallers,
      runningInstances,
      loadedModels,
      message: loadedModels.length
        ? `当前 Ollama 已加载：${loadedModels.join(", ")}`
        : "当前 Ollama 未常驻加载 Ornith 或 Qwen；启动任务后才会按需载入",
    };
  }
  async migrateSecrets() {
    for (const [id, relative] of [["deepseek", ".openclaw/secrets/codex-providers/deepseek_api_key"], ["agnes", ".openclaw/secrets/openclaw-runtime/secret-005"]]) {
      if (await this.store.secret(id)) continue;
      const marker = path.join(this.store.root, `.migrated-${id}`);
      try { await fs.access(marker); continue; } catch { }
      try {
        const secret = await fs.readFile(path.join(os.homedir(), relative), "utf8");
        await this.store.writeSecret(id, secret.trim());
        await fs.writeFile(marker, "1", { mode: 0o600 });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  async discover(route) {
    const checked = validateRoute(route);
    if (checked.protocol === "oauth") return { models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"], message: "官方登录模型；实际权限以 Codex 账号为准" };
    const result = await upstream(checked, await this.store.secret(checked.credentialID), "models", null, 15000);
    const data = await limitedJSON(result.body);
    if (!Array.isArray(data.data)) throw new Error("供应商未返回标准模型列表，请手动输入模型 ID");
    return { models: data.data.map((entry) => entry.id).filter((id) => typeof id === "string").slice(0, 2000), message: "已读取供应商模型列表；列表出现不代表已通过调用验证" };
  }
  async check(id) {
    const route = await this.store.route(id);
    if (route.archived) throw new Error("此模型已归档，请先恢复");
    if (!route.model) throw new Error("请先选择模型 ID");
    if (route.protocol === "oauth") {
      const auth = JSON.parse(await fs.readFile(path.join(sharedHome, "auth.json"), "utf8"));
      if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) throw new Error("请先在 Codex 中登录 ChatGPT");
      return { message: "ChatGPT 已登录；模型权限以实际请求为准" };
    }
    const result = await this.discover(route);
    if (!result.models.includes(route.model)) throw new Error("服务可连接，但未返回所选模型；请发现模型并重新选择");
    return { message: "连接正常，模型已列出；尚不等同真实推理验证" };
  }
  async gatewayReady() {
    const response = await fetch(`${gatewayURL}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    const data = await response.json();
    if (!response.ok || data.service !== "codex-model-assistant" || data.version !== 2) throw new Error("模型网关不可用，请重新安装或检查诊断");
  }
  async startGateway() {
    try { await this.gatewayReady(); return { message: "模型网关已运行" }; } catch { }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./model-gateway.mjs", import.meta.url))], { stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { await this.gatewayReady(); return { message: "模型网关已启动" }; } catch { }
    }
    throw new Error("模型网关未能启动，请查看运行诊断");
  }
  async probe(id) {
    const route = await this.store.route(id);
    if (route.archived || !route.model) throw new Error("请选择已启用且配置完整的模型");
    if (route.protocol === "oauth") return this.check(id);
    await this.gatewayReady();
    const started = Date.now();
    const response = await fetch(`${gatewayURL}/routes/${id}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await this.store.token(id)}` },
      body: JSON.stringify({ model: route.model, input: "Reply exactly MODEL_ASSISTANT_OK", max_output_tokens: 256, stream: false }), signal: AbortSignal.timeout(90000),
    });
    const data = await limitedJSON(response.body);
    if (!response.ok) throw new Error(data.error?.message || `调用失败 HTTP ${response.status}`);
    const output = data.output?.filter((item) => item.type === "message").flatMap((item) => item.content || []).map((part) => part.text || "").join("") || "";
    if (!output.includes("MODEL_ASSISTANT_OK")) throw new Error("服务已响应，但未返回预期验证文本；请核对模型与额度");
    const result = { testedAt: new Date().toISOString(), latencyMs: Date.now() - started, model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await this.store.credentialVersion(route.credentialID), ok: true };
    await atomicJSON(path.join(this.store.root, "checks", `${id}.json`), result);
    return { ...result, message: `真实推理通过 · ${result.latencyMs} ms（不代表所有 Codex 工具均兼容）` };
  }
  async prepare(id) {
    let route = await this.store.route(id);
    if (localCallers.includes(id) && route.noKey && route.protocol === "responses" && route.endpoint === "http://127.0.0.1:18791/v1") {
      const data = await this.store.read();
      await this.store.save({ ...route, protocol: "chat" }, data.revision);
      route = await this.store.route(id);
    }
    if (route.archived || !route.model) throw new Error("模型未配置完整或已归档");
    await this.check(id);
    if (route.protocol !== "oauth") await this.gatewayReady();
    const homePath = path.join(this.store.root, "instances-v2", id, "codex-home");
    const userDataPath = path.join(this.store.root, "instances-v2", id, "browser-data");
    await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
    await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const catalogPath = path.join(homePath, "model-catalog.json");
    await atomicJSON(catalogPath, catalog(route));
    let source = "";
    try { source = await fs.readFile(path.join(sharedHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = attachExpertConfig(renderProductConfig(source, route, catalogPath), id);
    const temporary = path.join(homePath, `.config-${randomUUID()}.toml`);
    await fs.writeFile(temporary, config, { mode: 0o600 });
    await fs.rename(temporary, path.join(homePath, "config.toml"));
    for (const name of ["auth.json", "skills", "plugins", "requirements.toml", "hooks.json"]) {
      const sourcePath = path.join(sharedHome, name);
      try {
        await fs.access(sourcePath);
        await fs.symlink(sourcePath, path.join(homePath, name));
      } catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
    }
    await fs.mkdir(path.join(homePath, "memories"), { recursive: true, mode: 0o700 });
    if (localCallers.includes(id)) {
      let original = "";
      try { original = await fs.readFile(path.join(sharedHome, "AGENTS.md"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.writeFile(path.join(homePath, "AGENTS.md"), original + "\n\n" + localExpertInstructions, { mode: 0o600 });
    }
    return { route, homePath, userDataPath };
  }
  async launch(id) {
    const prepared = await this.prepare(id);
    await fs.access(appBinary);
    const environment = { ...process.env, CODEX_HOME: prepared.homePath };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.AGNES_API_KEY;
    delete environment.DEEPSEEK_API_KEY;
    if (prepared.route.protocol !== "oauth") environment.CMA_ROUTE_TOKEN = await this.store.token(id);
    else delete environment.CMA_ROUTE_TOKEN;
    const child = spawn(appBinary, [`--user-data-dir=${prepared.userDataPath}`], { env: environment, stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { homePath: prepared.homePath, userDataPath: prepared.userDataPath, message: "已发送独立启动请求；同一模型会复用已有窗口。修改模型后请关闭该模型旧窗口再启动。" };
  }
  async importLibrary(input, revision) {
    if (input.schemaVersion !== 2 || !Array.isArray(input.routes) || input.routes.length > 500) throw new Error("导入格式不正确，最多允许 500 个模型");
    return this.store.mutate(revision, (data) => {
      for (const entry of input.routes) {
        if (entry.id === "official") continue;
        const id = `import-${randomUUID()}`;
        const route = validateRoute({ ...entry, id, credentialID: id });
        data.routes.push(route);
      }
      return data;
    });
  }
  async diagnostics() {
    const data = await this.store.publicData();
    let gateway = "未运行";
    try { await this.gatewayReady(); gateway = "正常"; } catch { }
    let installed = false;
    try { await fs.access(appBinary); installed = true; } catch { }
    return { message: `模型网关：${gateway}\nCodex App：${installed ? "已安装" : "未安装"}\n模型库：${data.routes.length} 个，版本 ${data.revision}\n密钥：用户私有文件（0700/0600），不包含在导出中\n接口适配：Responses / Chat / Anthropic\nChat 与 Anthropic：完整响应后输出，函数调用支持\n各供应商权限与完整工具兼容性需要实际验证` };
  }
}

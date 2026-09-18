import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelStore, atomicJSON, validateRoute } from "./model-store.mjs";
import { errorMessage, gatewayBuild, gatewayURL, upstream, limitedJSON } from "./model-gateway.mjs";
import { attachExpertConfig, localExpertInstructions } from "./local-expert-config.mjs";
import { localCallers, readExpertPolicy } from "./expert-policy.mjs";
import { localAgentInstructions } from "./local-agent-instructions.mjs";
import { buildRouterTable, modelInfo, routerCatalog, routerID, routerProviderID } from "./router.mjs";
import {
  importConversations,
  inspectConversationStore,
  inspectGlobalProjectState,
  mergeGlobalProjectState,
  repairProjectMetadata,
  snapshotConversations,
} from "./session-transfer.mjs";

const sharedHome = path.join(os.homedir(), ".codex");
const appBinary = "/Applications/Codex.app/Contents/MacOS/ChatGPT";
const execFileAsync = promisify(execFile);

function composeConfig(source, marker, { model, provider, catalogPath, name, baseURL }) {
  const clean = source.replace(new RegExp(`\\n?# BEGIN ${marker}[\\s\\S]*?# END ${marker}\\n?`, "g"), "\n");
  const lines = clean.split(/\r?\n/);
  const section = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = (section === -1 ? lines : lines.slice(0, section)).filter((line) => !/^\s*(model|model_provider|model_catalog_json|service_tier|profile)\s*=/.test(line));
  const routing = [`model = ${JSON.stringify(model)}`];
  if (provider) routing.push(`model_provider = "${provider}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`);
  const block = provider ? `# BEGIN ${marker}\n[model_providers.${provider}]\nname = ${JSON.stringify(name)}\nbase_url = ${JSON.stringify(baseURL)}\nenv_key = "CMA_ROUTE_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\n# END ${marker}` : "";
  return [top.join("\n").trim(), routing.join("\n"), section === -1 ? "" : lines.slice(section).join("\n").trim(), block].filter(Boolean).join("\n\n") + "\n";
}

export function renderProductConfig(source, route, catalogPath) {
  const official = route.protocol === "oauth";
  return composeConfig(source, "CODEX MODEL ASSISTANT V2", {
    model: route.model,
    provider: official ? "" : `cma_${route.id.replaceAll("-", "_")}`,
    catalogPath,
    name: route.name,
    baseURL: `${gatewayURL}/routes/${route.id}/v1`,
  });
}

export function renderRouterConfig(source, { model, catalogPath }) {
  return composeConfig(source, "CODEX MODEL ASSISTANT SWITCH WINDOW", {
    model,
    provider: routerProviderID,
    catalogPath,
    name: "Codex 模型助手 · 可切换窗口",
    baseURL: `${gatewayURL}/router/v1`,
  });
}

export function catalog(route) {
  return { models: [modelInfo(route, route.model, localCallers.includes(route.id) ? localAgentInstructions : "")] };
}

// 进程命令行里的 --user-data-dir 决定哪个窗口正在运行：模型窗口是 <root>/<instances-v2|continuations-v1>/<id>/browser-data，
// 可切换窗口是 <root>/router-v1/browser-data。抽成纯函数，便于用真实 ps 输出回归。
export function runningInstancesFromPS(output, root) {
  const escapedRoot = path.resolve(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`--user-data-dir=${escapedRoot}/(?:(?:instances-v2|continuations-v1)/([^/]+)|router-v1)/browser-data`, "g");
  return [...new Set([...String(output ?? "").matchAll(pattern)].map((match) => match[1] ?? "router"))].sort();
}

export class ProductService {
  constructor(store = new ModelStore()) { this.store = store; }
  async localRuntimeStatus() {
    const policy = await readExpertPolicy(this.store);
    let runningInstances = [];
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-axo", "args"], { maxBuffer: 1024 * 1024 });
      runningInstances = runningInstancesFromPS(stdout, this.store.root);
    } catch { }
    let loadedModels = [];
    let runtimeKnown = true;
    try {
      const routes = (await this.store.read()).routes.filter((route) => localCallers.includes(route.id));
      const origins = [...new Set(routes.map((route) => new URL(route.endpoint).origin))];
      for (const origin of origins) {
        const response = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok) throw new Error("Runtime unavailable");
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error("Invalid runtime status");
        loadedModels.push(...data.models.map((model) => model.name).filter(Boolean));
      }
    } catch { runtimeKnown = false; }
    return {
      preferredLocal: policy.preferredLocal,
      localCallers,
      runningInstances,
      loadedModels,
      message: !runtimeKnown ? "当前模型服务状态未知，无法确认是否驻留" : loadedModels.length
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
  // 不知道供应商实现的是哪套接口时，逐个真跑一次最小请求，把能用的那套记下来。
  async detectProtocol(id, { save = true } = {}) {
    const route = await this.store.route(id);
    if (route.archived) throw new Error("此模型已归档，请先恢复");
    if (!route.model) throw new Error("请先选择模型 ID");
    if (route.protocol === "oauth") return { protocol: "oauth", message: "官方登录入口不需要识别接口", tested: [] };
    const key = await this.store.secret(route.credentialID);
    const probes = {
      responses: { suffix: "responses", body: { model: route.model, input: "ping", max_output_tokens: 16, store: false } },
      chat: { suffix: "chat/completions", body: { model: route.model, messages: [{ role: "user", content: "ping" }], max_tokens: 16, stream: false } },
      anthropic: { suffix: "messages", body: { model: route.model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] } },
    };
    const tested = [];
    for (const protocol of [route.protocol, ...["responses", "chat", "anthropic"].filter((entry) => entry !== route.protocol)]) {
      const probe = probes[protocol];
      try {
        const result = await upstream({ ...route, protocol }, key, probe.suffix, probe.body, 30000);
        await limitedJSON(result.body);
        tested.push({ protocol, ok: true });
      } catch (error) {
        tested.push({ protocol, ok: false, reason: errorMessage(error) });
      }
    }
    const working = tested.filter((entry) => entry.ok).map((entry) => entry.protocol);
    if (!working.length) throw new Error(`三套接口都没跑通，请核对地址、密钥和模型 ID：\n${tested.map((entry) => `${entry.protocol}：${entry.reason}`).join("\n")}`);
    const chosen = working.includes(route.protocol) ? route.protocol : working[0];
    if (save && chosen !== route.protocol) {
      const data = await this.store.read();
      await this.store.save({ ...route, protocol: chosen }, data.revision);
    }
    return {
      protocol: chosen,
      changed: save && chosen !== route.protocol,
      tested,
      message: chosen === route.protocol
        ? `接口已确认：${chosen} 可用${working.length > 1 ? `（也可用：${working.filter((entry) => entry !== chosen).join("、")}）` : ""}`
        : `已自动把接口格式改为 ${chosen}（原来写的 ${route.protocol} 不通），现在可以验证了`,
    };
  }
  async gatewayHealth() {
    const response = await fetch(`${gatewayURL}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    const data = await response.json();
    if (!response.ok || data.service !== "codex-model-assistant" || data.version !== 2) throw new Error("模型网关不可用，请重新安装或检查诊断");
    return data;
  }
  async gatewayReady() {
    await this.gatewayHealth();
  }
  async restartGateway() {
    try { await execFileAsync("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/local.shift.codex-model-gateway`]); return; }
    catch { }
    try { await execFileAsync("/usr/bin/pkill", ["-f", "model-gateway.mjs"]); } catch { }
  }
  async startGateway() {
    let health = null;
    try { health = await this.gatewayHealth(); } catch { }
    if (health?.build === gatewayBuild) return { message: "模型网关已运行" };
    if (health) {
      // 有请求正在跑就先不升级，避免打断别人的任务；下次操作再试。
      if (Number(health.inflight) > 0) return { message: `模型网关有 ${health.inflight} 个请求正在进行，已推迟到下次操作自动升级到 ${gatewayBuild}` };
      await this.restartGateway();
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { if ((await this.gatewayHealth()).build === gatewayBuild) return { message: "模型网关已升级到当前版本" }; } catch { }
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./model-gateway.mjs", import.meta.url))], { stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { if ((await this.gatewayHealth()).build === gatewayBuild) return { message: health ? "模型网关已升级到当前版本" : "模型网关已启动" }; } catch { }
    }
    throw new Error("模型网关未能启动，请查看运行诊断");
  }
  async probe(id) {
    const route = await this.store.route(id);
    if (route.archived || !route.model) throw new Error("请选择已启用且配置完整的模型");
    if (route.protocol === "oauth") return this.check(id);
    await this.gatewayReady();
    const started = Date.now();
    const call = async () => {
      const response = await fetch(`${gatewayURL}/routes/${id}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await this.store.token(id)}` },
        body: JSON.stringify({ model: route.model, input: "Reply exactly MODEL_ASSISTANT_OK", max_output_tokens: 256, stream: false }), signal: AbortSignal.timeout(90000),
      });
      const data = await limitedJSON(response.body);
      if (!response.ok) throw new Error(data.error?.message || `调用失败 HTTP ${response.status}`);
      return data.output?.filter((item) => item.type === "message").flatMap((item) => item.content || []).map((part) => part.text || "").join("") || "";
    };
    let output, detected = null;
    try { output = await call(); }
    catch (error) {
      // 常见情况是接口格式选错（供应商只有 Chat 或 Messages）；自动识别一次并重试，用户不需要自己猜。
      detected = await this.detectProtocol(id).catch(() => null);
      if (!detected?.changed) throw error;
      output = await call();
    }
    if (!output.includes("MODEL_ASSISTANT_OK")) throw new Error("服务已响应，但未返回预期验证文本；请核对模型与额度");
    const current = await this.store.route(id);
    const result = { testedAt: new Date().toISOString(), latencyMs: Date.now() - started, model: current.model, endpoint: current.endpoint, protocol: current.protocol, credentialVersion: await this.store.credentialVersion(current.credentialID), ok: true };
    await atomicJSON(path.join(this.store.root, "checks", `${id}.json`), result);
    return { ...result, detected, message: `${detected?.changed ? `接口格式已按实测自动改为 ${detected.protocol}；` : ""}真实推理通过 · ${result.latencyMs} ms（不代表所有 Codex 工具均兼容）` };
  }
  async prepare(id, { continueExisting = false } = {}) {
    let route = await this.store.route(id);
    if (localCallers.includes(id) && route.noKey && route.protocol === "responses" && route.endpoint === "http://127.0.0.1:18791/v1") {
      const data = await this.store.read();
      await this.store.save({ ...route, protocol: "chat" }, data.revision);
      route = await this.store.route(id);
    }
    if (route.archived || !route.model) throw new Error("模型未配置完整或已归档");
    await this.check(id);
    if (route.protocol !== "oauth") await this.gatewayReady();
    const { hasContinuation } = await this.instancePaths(id);
    if (continueExisting && route.protocol === "oauth") throw new Error("官方会话无需导入第三方实例");
    if (continueExisting) await snapshotConversations(sharedHome, path.join(this.store.root, "continuations-v1", id, "codex-home"), route);
    const instanceRoot = continueExisting || hasContinuation ? "continuations-v1" : "instances-v2";
    const homePath = path.join(this.store.root, instanceRoot, id, "codex-home");
    const userDataPath = path.join(this.store.root, instanceRoot, id, "browser-data");
    await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
    await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const catalogPath = path.join(homePath, "model-catalog.json");
    let source = "";
    try { source = await fs.readFile(path.join(sharedHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const switching = route.switchable && route.protocol !== "oauth";
    let config;
    if (switching) {
      const table = buildRouterTable((await this.store.read()).routes);
      await atomicJSON(catalogPath, routerCatalog(table, localCallers));
      const slug = table.find((entry) => entry.route.id === id)?.slug || route.model;
      config = attachExpertConfig(renderRouterConfig(source, { model: slug, catalogPath }), id);
    } else {
      await atomicJSON(catalogPath, catalog(route));
      config = attachExpertConfig(renderProductConfig(source, route, catalogPath), id);
    }
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
  // 一个条目可能只有普通实例目录，也可能已经有一份"导入原会话"的副本目录。
  async instancePaths(id) {
    const continuationHome = path.join(this.store.root, "continuations-v1", id, "codex-home");
    let hasContinuation = false;
    try { await fs.access(path.join(continuationHome, "conversation-import.json")); hasContinuation = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const root = hasContinuation ? "continuations-v1" : "instances-v2";
    return { hasContinuation, homePath: path.join(this.store.root, root, id, "codex-home") };
  }
  // 让已有条目的窗口也能在 Codex 里直接换模型：同一个 CODEX_HOME，对话和任务库原地保留。
  async setSwitching(id, enabled) {
    const route = await this.store.route(id);
    if (route.protocol === "oauth") throw new Error("官方 ChatGPT 入口自带模型选择，不需要切换窗口");
    if (enabled && !route.model) throw new Error("请先选择模型 ID");
    const data = await this.store.read();
    await this.store.save({ ...route, switchable: Boolean(enabled) }, data.revision);
    // 该条目可能同时有普通实例目录和"导入原会话"副本目录，两个都改，保证下次打开哪个窗口都一致。
    const homes = ["instances-v2", "continuations-v1"].map((root) => path.join(this.store.root, root, id, "codex-home"));
    const table = buildRouterTable((await this.store.read()).routes);
    let source = "";
    try { source = await fs.readFile(path.join(sharedHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let touched = false;
    for (const homePath of homes) {
      try { await fs.access(path.join(homePath, "config.toml")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      touched = true;
      const catalogPath = path.join(homePath, "model-catalog.json");
      const current = await this.store.route(id);
      const updated = enabled
        ? renderRouterConfig(source, { model: table.find((entry) => entry.route.id === id)?.slug || route.model, catalogPath })
        : renderProductConfig(source, current, catalogPath);
      await atomicJSON(catalogPath, enabled ? routerCatalog(table, localCallers) : catalog(current));
      const temporary = path.join(homePath, `.config-${randomUUID()}.toml`);
      await fs.writeFile(temporary, attachExpertConfig(updated, id), { mode: 0o600 });
      await fs.rename(temporary, path.join(homePath, "config.toml"));
    }
    return {
      ...(await this.switchSummary()),
      message: enabled
        ? `「${route.name}」的窗口已改为可切换模型${touched ? "" : "（首次启动生效）"}：关闭这个窗口，再从助手点「启动 Codex」，对话不会丢；之后在 Codex 顶部直接换模型即可。`
        : `「${route.name}」已恢复单模型窗口：关闭这个窗口再启动即可。`,
    };
  }
  async launch(id, options = {}) {
    const prepared = await this.prepare(id, options);
    await fs.access(appBinary);
    const environment = { ...process.env, CODEX_HOME: prepared.homePath };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.AGNES_API_KEY;
    delete environment.DEEPSEEK_API_KEY;
    if (prepared.route.protocol !== "oauth") environment.CMA_ROUTE_TOKEN = await this.store.token(prepared.route.switchable ? routerID : id);
    else delete environment.CMA_ROUTE_TOKEN;
    const child = spawn(appBinary, [`--user-data-dir=${prepared.userDataPath}`], { env: environment, stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { homePath: prepared.homePath, userDataPath: prepared.userDataPath, message: options.continueExisting ? "已打开原会话的独立副本；后续工作保存在此模型窗口，原官方会话不受影响。" : "已发送独立启动请求；同一模型会复用已有窗口。修改模型后请关闭该模型旧窗口再启动。" };
  }
  switchPaths() {
    const root = path.join(this.store.root, "router-v1");
    const homePath = path.join(root, "codex-home");
    return { root, homePath, userDataPath: path.join(root, "browser-data"), catalogPath: path.join(homePath, "model-catalog.json") };
  }
  async switchSummary() {
    const data = await this.store.read();
    const table = buildRouterTable(data.routes);
    const status = await this.localRuntimeStatus();
    return {
      switchModels: table.map(({ slug, route }) => ({ id: route.id, slug, name: route.name, model: route.model, vendor: route.vendor, protocol: route.protocol })),
      routerRunning: status.runningInstances.includes("router"),
      routerRunningInstances: status.runningInstances,
    };
  }
  async switchWindowSources(target = "all") {
    const sources = [];
    if (target === "all" || target === "shared") sources.push(sharedHome);
    // 已归档的模型窗口不参与合并，免得把停用模型的项目带进工作窗口；显式指定某个条目时仍按用户意愿处理。
    const archived = new Set();
    if (target === "all") {
      const data = await this.store.read();
      for (const route of data.routes ?? []) if (route.archived) archived.add(route.id);
    }
    for (const slot of ["instances-v2", "continuations-v1"]) {
      if (target === "all") {
        let names = [];
        try { names = await fs.readdir(path.join(this.store.root, slot)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        sources.push(...names.filter((name) => !archived.has(name)).map((name) => path.join(this.store.root, slot, name, "codex-home")));
      } else if (target !== "shared") {
        sources.push(path.join(this.store.root, slot, target, "codex-home"));
      }
    }
    return [...new Set(sources.map((entry) => path.resolve(entry)))];
  }
  async syncSwitchWindowHistory(homePath, model, target = "all") {
    try { await fs.access(path.join(homePath, "state_5.sqlite")); }
    catch (error) {
      if (error.code === "ENOENT") return { imported: 0, missingFiles: 0, sources: [], pendingFirstLaunch: true };
      throw error;
    }
    return importConversations(await this.switchWindowSources(target), homePath, { model, provider: routerProviderID });
  }
  async repairSwitchWindowMetadata(target = "all") {
    const { homePath } = this.switchPaths();
    const report = await repairProjectMetadata(await this.switchWindowSources(target), homePath);
    const addedProjects = Math.max(0, (report.after.projects || 0) - (report.before.projects || 0));
    const addedRoots = Math.max(0, (report.after.projectRoots || 0) - (report.before.projectRoots || 0));
    const reassignedThreads = report.reassignedThreads || 0;
    const global = report.globalState ?? {};
    const parts = [];
    if (addedProjects || addedRoots) parts.push(`补入 ${addedProjects} 个项目、${addedRoots} 条目录映射`);
    if (reassignedThreads) parts.push(`为 ${reassignedThreads} 条会话补回项目归属`);
    if (global.wrote) parts.push(`补入 ${global.projectsAdded || 0} 个侧边栏分组、${global.assignmentsAdded || 0} 条会话归属（去重 ${global.projectsDeduped || 0} 个重复项目）`);
    const changed = Boolean(parts.length);
    const running = (await this.localRuntimeStatus()).runningInstances.includes(routerID);
    return {
      ...(await this.switchSummary()),
      switchHealth: report.after,
      globalState: global.after ?? null,
      message: [
        changed ? `已修复工作窗口分组：${parts.join("，")}。` : "工作窗口的项目分组元数据已完整，无需修复。",
        changed && running ? "工作窗口正在运行，需重启工作窗口后才能看到分组。" : changed ? "重新打开工作窗口后即可看到。" : "",
        global.error ? `侧边栏分组修复未完成：${global.error}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  async prepareSwitchWindow(initial = "") {
    const data = await this.store.read();
    const table = buildRouterTable(data.routes);
    if (!table.length) throw new Error("还没有可切换的模型：请先配置至少一个第三方模型并填写密钥");
    const chosen = table.find((entry) => entry.route.id === initial || entry.slug === initial) || table[0];
    await this.startGateway();
    const paths = this.switchPaths();
    await fs.mkdir(paths.homePath, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.userDataPath, { recursive: true, mode: 0o700 });
    // 启动前补项目分组：此刻没有 Codex 进程持有全局状态，不会被内存态写回覆盖。
    let globalState = null;
    try {
      globalState = await mergeGlobalProjectState(await this.switchWindowSources("all"), paths.homePath);
    } catch (error) {
      globalState = { destination: paths.homePath, error: error.message, wrote: false };
    }
    await atomicJSON(paths.catalogPath, routerCatalog(table, localCallers));
    let source = "";
    try { source = await fs.readFile(path.join(sharedHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(paths.homePath, `.config-${randomUUID()}.toml`);
    await fs.writeFile(temporary, renderRouterConfig(source, { model: chosen.slug, catalogPath: paths.catalogPath }), { mode: 0o600 });
    await fs.rename(temporary, path.join(paths.homePath, "config.toml"));
    for (const name of ["auth.json", "skills", "plugins", "requirements.toml", "hooks.json"]) {
      const sourcePath = path.join(sharedHome, name);
      try { await fs.access(sourcePath); await fs.symlink(sourcePath, path.join(paths.homePath, name)); }
      catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
    }
    await fs.mkdir(path.join(paths.homePath, "memories"), { recursive: true, mode: 0o700 });
    return { ...paths, table, chosen, globalState };
  }
  async launchSwitchWindow(initial = "") {
    const prepared = await this.prepareSwitchWindow(initial);
    const imported = await this.syncSwitchWindowHistory(prepared.homePath, prepared.chosen.slug);
    await fs.access(appBinary);
    const environment = { ...process.env, CODEX_HOME: prepared.homePath, CMA_ROUTE_TOKEN: await this.store.token(routerID) };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.AGNES_API_KEY;
    delete environment.DEEPSEEK_API_KEY;
    const child = spawn(appBinary, [`--user-data-dir=${prepared.userDataPath}`], { env: environment, stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const importedMessage = imported.pendingFirstLaunch
      ? "首次打开会先建立统一任务库；关闭后再次打开，会自动把官方与 API 会话补进来。"
      : imported.imported
        ? ` 已自动补入 ${imported.imported} 个已有会话。`
        : "";
    return { ...(await this.switchSummary()), message: `已打开可切换窗口：在 Codex 顶部的模型选择里直接换模型，同一个窗口里的对话继续有效。当前 ${prepared.chosen.route.name}，可选 ${prepared.table.length} 个模型。${importedMessage}` };
  }
  async importHistory(target = "all") {
    const prepared = await this.prepareSwitchWindow("");
    const report = await this.syncSwitchWindowHistory(prepared.homePath, prepared.chosen.slug, target);
    if (report.pendingFirstLaunch) throw new Error("请先启动一次可切换窗口，让 Codex 建好任务库，然后关闭它再导入已有会话");
    const scanned = report.sources.filter((entry) => entry.imported > 0).length;
    const global = report.globalState ?? {};
    const grouping = global.wrote
      ? ` 同时补入 ${global.projectsAdded || 0} 个侧边栏分组、${global.assignmentsAdded || 0} 条会话归属。`
      : "";
    return {
      ...(await this.switchSummary()),
      importReport: report,
      message: report.imported
        ? `已导入 ${report.imported} 个会话（来自 ${scanned} 个任务库）。重新打开切换窗口后即可看到；来源任务库没有被改动。${grouping}`
        : `没有发现新的会话可导入；已有的会话已全部在切换窗口里。${grouping}`,
    };
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
    const table = buildRouterTable(data.routes);
    const active = data.routes.filter((route) => !route.archived && route.protocol !== "oauth");
    const missingKey = active.filter((route) => !route.noKey && !route.hasKey).map((route) => route.name);
    const verifiedCount = active.filter((route) => route.verifiedAt).length;
    const switchable = active.filter((route) => route.switchable).map((route) => route.name);
    const prepared = active.filter((route) => route.fallback).length;
    const switchStore = await inspectConversationStore(this.switchPaths().homePath);
    const switchLine = switchStore.ready
      ? `工作窗口任务库：${switchStore.threads} 条会话，${switchStore.projects} 个项目，${switchStore.projectRoots} 条目录映射，${switchStore.threadsWithProject || 0} 条已挂到项目`
      : "工作窗口任务库：尚未初始化，先打开一次工作窗口即可建立";
    const switchHealth = switchStore.ready && switchStore.threads > 0 && (
      switchStore.projects === 0 ||
      (switchStore.projects > 0 && (switchStore.threadsWithProject || 0) === 0)
    )
      ? "项目分组关系缺失：会话仍在，但侧边栏可能只剩列表；可直接点「修复工作窗口」补回"
      : "项目分组元数据：正常";
    return {
      message: [
        `模型网关：${gateway}`,
        `Codex App：${installed ? "已安装" : "未安装"}`,
        `模型库：${data.routes.length} 个，版本 ${data.revision}`,
        `可切换窗口：${table.length} 个模型可选（官方 ChatGPT 登录与已归档模型不在其中）`,
        switchLine,
        switchHealth,
        `本窗口可切换的条目：${switchable.length ? switchable.join("、") : "尚未开启，可在条目里点「本窗口也可切换模型」"}`,
        `配置了备用模型：${prepared ? `${prepared} 个` : "无，可在编辑模型里选「主模型失败时改用」"}`,
        `真实推理已验证：${verifiedCount}/${active.length}${missingKey.length ? `；还缺 Key：${missingKey.join("、")}` : ""}`,
        "密钥：用户私有文件（0700/0600），不包含在导出中",
        "接口适配：Responses / Chat / Anthropic；Chat 与 Anthropic 按流式增量输出，函数调用支持",
        "各供应商权限与完整工具兼容性需要实际验证",
      ].join("\n"),
    };
  }
}

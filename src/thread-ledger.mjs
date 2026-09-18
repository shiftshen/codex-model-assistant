// 「对话账本」：Codex 的模型是按对话(thread)存的，不是按窗口。
//
// 这是最容易看错的一处：窗口顶部显示的是"这个窗口新开对话时的默认模型"，
// 而一个已经存在的对话会一直用自己当初选的那个模型。于是出现"我明明在
// opencode 窗口里，怎么 DeepSeek 官方还在扣钱"——因为那个旧对话从头到尾
// 都挂在 DeepSeek 官方上，窗口归属跟它无关。
//
// 这里直接读每个对话的 thread_settings（Codex 自己写的当前模型），列出
// 「哪个对话、在哪个目录、用的什么模型、钱从哪出」，把归属摊开给用户看。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSION_HEAD_BYTES = 384 * 1024;
// 尾部窗口分两级：大多数对话最后一条 thread_settings 就在末尾几百 KB 内，
// 但长会话（几十上百 MB）最后一轮可能写了好几 MB，一步到位要读太多盘。
const TAIL_WINDOWS = [2 * 1024 * 1024, 6 * 1024 * 1024];
const MAX_TITLE = 56;

// Codex 遇到重名模型会自动加 -2 / -3 后缀（我们库里有三个路由的模型名都叫
// deepseek-v4.1-flash）。拿它去比对上游之前要先还原，否则一个路由都匹配不上，
// 账目会全部变成"未知"。
export function stripModelDedupe(model) {
  return String(model ?? "").trim().replace(/-\d+$/, "");
}

async function readRange(file, start, length) {
  if (length <= 0) return "";
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeJSONString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

// 一行是不是真正的「对话设置」事件。这里必须真解析 JSON 并校验事件类型：
// 会话正文里也会出现 thread_settings_applied 这几个字（我们讨论这个字段时，
// 模型的输出和工具参数被原样存进了会话），只按关键字匹配会读到那些假行，
// 于是"未知模型"或者把归属算到别的上游。
function parseSettingsLine(line) {
  if (!line.includes("thread_settings_applied")) return null;
  const head = line.match(/^\{"timestamp":"[^"]*","ordinal":\d+,"type":"([^"]+)"/);
  if (head && head[1] !== "event_msg") return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed?.type !== "event_msg" || parsed.payload?.type !== "thread_settings_applied") return null;
  const settings = parsed.payload.thread_settings ?? {};
  if (!settings.model) return null;
  return {
    model: String(settings.model),
    providerID: String(settings.model_provider_id ?? ""),
    cwd: String(settings.cwd ?? ""),
  };
}

// thread_settings_applied 是 Codex 写进会话的「这个对话现在用哪个模型」，也是
// 唯一可信的来源。不用工具参数里的 model 字段——那是模型在请求里带的名字，
// 同一个对话里会同时出现好几个，读错了会把归属算到别人头上。
export function lastThreadSettings(text) {
  if (!text) return null;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const settings = parseSettingsLine(lines[index]);
    if (settings) return settings;
  }
  return null;
}

async function settingsFromTail(file, size) {
  for (const window of TAIL_WINDOWS) {
    const length = Math.min(window, size);
    const settings = lastThreadSettings(await readRange(file, size - length, length));
    if (settings) return settings;
  }
  return null;
}

function sessionMeta(head) {
  const first = head.split("\n", 1)[0] ?? "";
  const pick = (key) => (first.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`)) ?? [])[1] ?? "";
  return { id: pick("session_id"), cwd: pick("cwd"), provider: pick("model_provider") };
}

// 会话第一条用户消息当标题。开头那些 <recommended_plugins> / <environment_context>
// 是 Codex 自己注入的上下文，不是用户打的字，要跳过。
export function firstUserText(head) {
  if (!head) return "";
  const patterns = [
    /"type"\s*:\s*"user_message"[\s\S]{0,120}?"message"\s*:\s*"((?:[^"\\]|\\.){1,400})"/g,
    /"role"\s*:\s*"user"\s*,[\s\S]{0,400}?"text"\s*:\s*"((?:[^"\\]|\\.){1,400})"/g,
  ];
  for (const pattern of patterns) {
    for (const match of head.matchAll(pattern)) {
      const text = decodeJSONString(match[1]).replace(/\s+/g, " ").trim();
      if (!text || text.startsWith("<") || text.startsWith("{")) continue;
      return text.slice(0, MAX_TITLE);
    }
  }
  return "";
}

function hostLabel(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return String(endpoint ?? "") || "未知";
  }
}

// 钱的出处。model_provider_id 以 cma_ 开头 = 走助手网关，再按端点判断是谁；
// 否则是 Codex 直连（官方订阅就是 openai / chatgpt）。
export function billingFor(settings, routesByModel) {
  const model = stripModelDedupe(settings?.model);
  const provider = String(settings?.providerID ?? "");
  if (!model) return { kind: "unknown", label: "未知模型", detail: "" };
  if (provider && !provider.startsWith("cma_")) {
    if (/^(openai|chatgpt)/i.test(provider)) return { kind: "subscription", label: "ChatGPT 订阅额度", detail: "官方直连" };
    return { kind: "direct", label: `${provider} 直连`, detail: "不经过助手" };
  }
  const routes = routesByModel.get(model) ?? [];
  if (!routes.length) return { kind: "unknown", label: "未知上游", detail: `模型 ${model} 不在模型库里` };
  const hosts = [...new Set(routes.map((route) => hostLabel(route.endpoint)))];
  if (hosts.some((host) => host.endsWith("api.deepseek.com"))) return { kind: "balance", label: "DeepSeek 官方余额", detail: "按量计费" };
  if (hosts.some((host) => host.endsWith("opencode.ai"))) return { kind: "quota", label: "opencode 额度", detail: "包月额度" };
  if (hosts.some((host) => host.endsWith("chatgpt.com"))) return { kind: "subscription", label: "ChatGPT 订阅额度", detail: "官方直连" };
  return { kind: "third", label: hosts.join("、"), detail: routes.map((route) => route.name).join("、") };
}

async function collectSessions(directory, depth, found) {
  if (depth > 3) return found;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectSessions(full, depth + 1, found);
    else if (entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

async function registryNames(root) {
  try {
    const registry = JSON.parse(await fs.readFile(path.join(root, "windows.json"), "utf8"));
    return new Map((registry.windows ?? []).map((entry) => [entry.id, entry.name]));
  } catch {
    return new Map();
  }
}

// 每个窗口/实例各有自己的 CODEX_HOME，对话也就分散在各处，必须逐个扫。
export async function threadScopes(root, homeDirectory = os.homedir()) {
  const names = await registryNames(root);
  const scopes = [
    { key: "official", label: "官方 Codex", home: path.join(homeDirectory, ".codex") },
    { key: "router", label: names.get("router") ?? "常用", home: path.join(root, "router-v1", "codex-home") },
  ];
  for (const slot of ["windows-v1", "continuations-v1", "instances-v2"]) {
    let ids;
    try {
      ids = await fs.readdir(path.join(root, slot), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory()) continue;
      const name = names.get(entry.name) ?? entry.name;
      scopes.push({ key: entry.name, label: `${name}`, home: path.join(root, slot, entry.name, "codex-home") });
    }
  }
  return scopes;
}

export async function readThreadCard(file, stat) {
  const size = stat?.size ?? (await fs.stat(file)).size;
  const head = await readRange(file, 0, Math.min(SESSION_HEAD_BYTES, size));
  const settings = (await settingsFromTail(file, size)) ?? lastThreadSettings(head);
  const meta = sessionMeta(head);
  return {
    id: meta.id || path.basename(file).replace(/^rollout-/, "").replace(/\.jsonl$/, "").slice(-36),
    title: firstUserText(head),
    cwd: settings?.cwd || meta.cwd || "",
    model: settings?.model ?? "",
    providerID: settings?.providerID || meta.provider || "",
    sizeBytes: size,
    lastWriteMs: stat?.mtimeMs ?? 0,
  };
}

// 只回报「最近还在动」的对话。用户关心的是钱正在往哪流，不是历史。
export async function listLiveThreads(root, { withinMinutes = 30, now = Date.now(), homeDirectory = os.homedir() } = {}) {
  const cutoff = now - withinMinutes * 60_000;
  const scopes = await threadScopes(root, homeDirectory);
  const cards = [];
  for (const scope of scopes) {
    const files = await collectSessions(path.join(scope.home, "sessions"), 0, []);
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      const card = await readThreadCard(file, stat);
      cards.push({ ...card, scope: scope.label, scopeKey: scope.key });
    }
  }
  cards.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
  return cards;
}

export function routesByModel(routes) {
  const index = new Map();
  for (const route of routes) {
    const key = stripModelDedupe(route.model);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), route]);
  }
  return index;
}

// 给界面用的成品：扫盘 + 判归属 + 算「几分钟前」，一次到位。
export async function liveThreadRows(root, routes, { withinMinutes = 30, now = Date.now() } = {}) {
  const index = routesByModel(routes);
  const threads = await listLiveThreads(root, { withinMinutes, now });
  return threads.map((thread) => ({
    ...thread,
    billing: billingFor(thread, index),
    minutesAgo: Math.max(0, Math.round((now - thread.lastWriteMs) / 60_000)),
  }));
}

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
import { buildRouterTable } from "./router.mjs";

const SESSION_HEAD_BYTES = 384 * 1024;
// 尾部窗口分两级：大多数对话最后一条 thread_settings 就在末尾几百 KB 内，
// 但长会话（几十上百 MB）最后一轮可能写了好几 MB，一步到位要读太多盘。
const TAIL_WINDOWS = [2 * 1024 * 1024, 6 * 1024 * 1024];
const MAX_TITLE = 56;

// 仅用于展示/兼容旧数据的基础模型名。注意：账单归属绝不能靠它判断——
// 在可切换窗口里 `model-2` / `model-3` 是 buildRouterTable() 生成的稳定 slug，
// 分别对应不同 route；把后缀砍掉会把第二个供应商的账算到第一个供应商头上。
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

function billingForRoute(route) {
  const host = hostLabel(route?.endpoint);
  if (host.endsWith("api.deepseek.com")) return { kind: "balance", label: "DeepSeek 官方余额", detail: "按量计费" };
  if (host.endsWith("opencode.ai")) return { kind: "quota", label: "opencode 额度", detail: "包月额度" };
  if (host.endsWith("chatgpt.com")) return { kind: "subscription", label: "ChatGPT 订阅额度", detail: "官方直连" };
  return { kind: "third", label: host, detail: route?.name ?? "第三方上游" };
}

// 钱的出处必须精确到 route：
// - cma_router：thread_settings.model 是 buildRouterTable() 生成的唯一 slug，精确反查；
// - cma_<route-id>：单模型窗口直接从 provider ID 反查；
// - 其它 provider：不经过助手，按直连处理。
// 绝不再把 `foo-2` 去成 `foo` 后再猜供应商。
export function billingFor(settings, routeIndex) {
  const model = String(settings?.model ?? "").trim();
  const provider = String(settings?.providerID ?? "").trim();
  if (!model) return { kind: "unknown", label: "未知模型", detail: "" };
  if (provider && !provider.startsWith("cma_")) {
    if (/^(openai|chatgpt)/i.test(provider)) return { kind: "subscription", label: "ChatGPT 订阅额度", detail: "官方直连" };
    return { kind: "direct", label: `${provider} 直连`, detail: "不经过助手" };
  }
  const key = provider === "cma_router" ? `slug:${model}` : (provider.startsWith("cma_") ? `provider:${provider}` : `model:${model}`);
  const route = routeIndex.get(key) ?? null;
  if (!route) return { kind: "unknown", label: "未知上游", detail: `模型 ${model} / provider ${provider || "?"} 无法唯一对应模型库条目` };
  return billingForRoute(route);
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
    { key: "official", label: "ChatGPT Desktop", home: path.join(homeDirectory, ".codex") },
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
  // 可切换窗口的 model 字段就是这个 slug；buildRouterTable 的排序/去重规则是唯一权威。
  for (const { slug, route } of buildRouterTable(routes)) index.set(`slug:${slug}`, route);
  // 单模型窗口 provider 写成 cma_<route-id>，因此也能无歧义反查。
  for (const route of routes) {
    const provider = `cma_${String(route.id ?? "").replaceAll("-", "_")}`;
    index.set(`provider:${provider}`, route);
  }
  // 只有模型名在库里唯一时才提供无 provider 的兼容回退；重名时宁可报未知也不能算错账。
  const groups = new Map();
  for (const route of routes) {
    const model = String(route.model ?? "").trim();
    if (!model) continue;
    groups.set(model, [...(groups.get(model) ?? []), route]);
  }
  for (const [model, matches] of groups) if (matches.length === 1) index.set(`model:${model}`, matches[0]);
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

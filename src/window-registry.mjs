import fs from "node:fs/promises";
import path from "node:path";
import { atomicJSON } from "./model-store.mjs";

// 工作窗口注册表：每个窗口一份独立的 CODEX_HOME 与浏览器数据目录，互不干扰。
// 槽位 router 是历史遗留的唯一窗口（router-v1），保留原路径以免迁移已有会话；其余槽位放在 windows-v1/<id>。
export const legacyWindowID = "router";
export const windowsRootName = "windows-v1";

const registryFile = "windows.json";

export function isValidWindowID(value) {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(String(value ?? "").trim());
}

export function windowPaths(root, id) {
  const base = id === legacyWindowID ? path.join(root, "router-v1") : path.join(root, windowsRootName, id);
  return {
    id,
    root: base,
    homePath: path.join(base, "codex-home"),
    userDataPath: path.join(base, "browser-data"),
    catalogPath: path.join(base, "codex-home", "model-catalog.json"),
    legacy: id === legacyWindowID,
  };
}

export function defaultWindowRegistry() {
  return {
    schemaVersion: 1,
    windows: [{ id: legacyWindowID, name: "窗口 1", initialModel: "", createdAt: "" }],
  };
}

function normalizeWindow(input, index) {
  const id = String(input?.id ?? "").trim();
  if (!isValidWindowID(id)) throw new Error(`窗口标识无效：${id}`);
  const name = String(input?.name ?? "").trim().slice(0, 40) || `窗口 ${index + 1}`;
  if (/[\u0000-\u001f]/.test(name)) throw new Error("窗口名称包含控制字符");
  return {
    id,
    name,
    initialModel: String(input?.initialModel ?? "").trim().slice(0, 200),
    createdAt: String(input?.createdAt ?? "").trim().slice(0, 40),
  };
}

export function normalizeWindowRegistry(input) {
  const raw = Array.isArray(input?.windows) ? input.windows : [];
  const seen = new Set();
  const windows = [];
  for (const entry of raw) {
    const window = normalizeWindow(entry, windows.length);
    if (seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }
  if (!seen.has(legacyWindowID)) windows.unshift(defaultWindowRegistry().windows[0]);
  return { schemaVersion: 1, windows };
}

export async function readWindowRegistry(root) {
  try {
    const text = await fs.readFile(path.join(root, registryFile), "utf8");
    return normalizeWindowRegistry(JSON.parse(text));
  } catch (error) {
    if (error.code === "ENOENT") return defaultWindowRegistry();
    if (error instanceof SyntaxError) throw new Error(`窗口注册表已损坏：${path.join(root, registryFile)}`);
    throw error;
  }
}

export async function writeWindowRegistry(root, registry) {
  const normalized = normalizeWindowRegistry(registry);
  await atomicJSON(path.join(root, registryFile), normalized);
  return normalized;
}

// 新建窗口取 w2、w3……保证不和已有槽位冲突，也不和遗留槽位撞名。
export function nextWindowID(registry) {
  const taken = new Set((registry?.windows ?? []).map((entry) => entry.id));
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `w${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("窗口数量已达上限");
}

export function nextWindowName(registry) {
  const taken = new Set((registry?.windows ?? []).map((entry) => entry.name));
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `窗口 ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `窗口 ${(registry?.windows ?? []).length + 1}`;
}

export function findWindow(registry, id) {
  return (registry?.windows ?? []).find((entry) => entry.id === id) ?? null;
}

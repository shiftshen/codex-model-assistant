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

// —— 注册表并发保护 ——
// windows.json 是「读-改-写」：多开时两次建窗请求若同时进行，两边会算出同一个 w2，
// 后写的一方覆盖前者，另一个 Codex 进程就成了注册表里查不到的孤儿——进程在跑，界面上却看不见、也管不了。
// 所以所有写入都串行化：锁文件 + 超时重试 + 死锁自动接管。
export function registryLockPath(root) {
  return path.join(root, `${registryFile}.lock`);
}

// staleMs 必须明显小于 timeoutMs：否则持有者异常退出后，锁还没到接管时限就先撞上等待上限，
// 建窗会报「正被另一个操作占用」——用户看到的就是「点了没反应，只能开一个」。
export async function withWindowLock(root, fn, { timeoutMs = 15000, staleMs = 5000, pollMs = 40 } = {}) {
  const lockPath = registryLockPath(root);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  for (;;) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 上次异常退出可能留下没人释放的锁：超过 staleMs 没更新就直接接管，避免永久卡住。
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() > deadline) throw new Error("窗口注册表正被另一个操作占用，请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

// 在锁内分配窗口号并落盘，保证并发建窗一定拿到不同编号。
// reserved 用来避开「还在跑但没登记」的孤儿窗口，免得新窗口和它的目录撞车。
export async function allocateWindow(root, { initialModel = "", reserved = [], lock } = {}) {
  return withWindowLock(root, async () => {
    const registry = await readWindowRegistry(root);
    const taken = [...registry.windows.map((entry) => entry.id), ...reserved];
    const id = nextWindowID({ windows: taken.map((value) => ({ id: value })) });
    // 默认名字跟着编号走（w3 → 窗口 3），避开被占用的编号时名字才不会错位；重名再退回到第一个空位。
    const fromId = (id.match(/^w(\d+)$/) || [])[1];
    const takenNames = new Set(registry.windows.map((entry) => entry.name));
    const preferred = fromId ? `窗口 ${fromId}` : nextWindowName(registry);
    const window = {
      id,
      name: takenNames.has(preferred) ? nextWindowName(registry) : preferred,
      initialModel: String(initialModel ?? "").trim().slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    await writeWindowRegistry(root, { ...registry, windows: [...registry.windows, window] });
    return window;
  }, lock);
}

// 只改目标窗口的字段；不动同一时刻新加进来的窗口（改名/记住起始模型都走这里）。
export async function updateWindow(root, id, patch, lock) {
  return withWindowLock(root, async () => {
    const registry = await readWindowRegistry(root);
    const target = findWindow(registry, id);
    if (!target) return null;
    const merged = { ...target, ...patch, id: target.id };
    const windows = registry.windows.map((entry) => (entry.id === id ? merged : entry));
    await writeWindowRegistry(root, { ...registry, windows });
    return merged;
  }, lock);
}

export async function removeWindow(root, id, lock) {
  return withWindowLock(root, async () => {
    const registry = await readWindowRegistry(root);
    const windows = registry.windows.filter((entry) => entry.id !== id);
    await writeWindowRegistry(root, { ...registry, windows });
    return windows.length !== registry.windows.length;
  }, lock);
}

// 登记一个已经跑起来的未登记窗口（接管孤儿）。
export async function registerRunningWindow(root, id, { initialModel = "", lock } = {}) {
  if (!isValidWindowID(id)) throw new Error(`窗口标识无效：${id}`);
  return withWindowLock(root, async () => {
    const registry = await readWindowRegistry(root);
    const existing = findWindow(registry, id);
    if (existing) return { window: existing, added: false };
    const names = new Set(registry.windows.map((entry) => entry.name));
    let name = `恢复的窗口 ${id}`;
    for (let index = 2; names.has(name); index += 1) name = `恢复的窗口 ${id} (${index})`;
    const window = { id, name, initialModel: String(initialModel ?? "").trim().slice(0, 200), createdAt: new Date().toISOString() };
    await writeWindowRegistry(root, { ...registry, windows: [...registry.windows, window] });
    return { window, added: true };
  }, lock);
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

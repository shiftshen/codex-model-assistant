import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJSON } from "./model-store.mjs";
import { legacyWindowID, windowPaths } from "./window-registry.mjs";

const execFileAsync = promisify(execFile);
const sqliteBinary = "/usr/bin/sqlite3";

// 30 天阈值、审计清单目录名、续接窗口槽位——都按 UI 与文档里的承诺固定下来。
export const staleDays = 30;
export const cleanupFolder = "cleanup";
const continuationSlot = "continuations-v1";

// 浏览器侧缓存目录：全都是可再生的（下次启动自己下载或重建）。
// 刻意不碰 Cookies、Local Storage、IndexedDB、Preferences——那些装着登录状态和窗口设置，删了用户就得重新登录。
export const browserCacheDirs = Object.freeze([
  "component_crx_cache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "WasmTtsEngine",
  "WidevineCdm",
  "Crashpad",
  "sentry",
  "DeferredBrowserMetrics",
  "OptimizationHints",
  "OptimizationGuideModelsManifest",
  "OptimizationGuidePredictionModels",
  "segmentation_platform",
  "ActorSafetyLists",
  "CertificateRevocation",
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/ShaderCache",
  "Default/GrShaderCache",
  "Default/Service Worker/CacheStorage",
  "Default/Service Worker/ScriptCache",
]);

// 浏览器缓存只在这四类槽位里收；instances/ 是早期单模型窗口的遗留目录，状态不明，不碰。
const browserSlots = Object.freeze([
  { slot: "router-v1", fixedID: legacyWindowID },
  { slot: "instances-v2" },
  { slot: continuationSlot },
  { slot: "windows-v1" },
]);

// threads.updated_at 是「秒」，和 Date.now() 的毫秒不能直接比。
export function staleCutoffSeconds(now = Date.now()) {
  return Math.floor(now / 1000) - staleDays * 86400;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function sqliteJSON(dbPath, sql) {
  try {
    const { stdout } = await execFileAsync(sqliteBinary, ["-cmd", ".timeout 10000", "-json", dbPath, sql], { maxBuffer: 64 * 1024 * 1024 });
    const text = String(stdout ?? "").trim();
    return text ? JSON.parse(text) : [];
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || error.message;
    throw new Error(`读取 ${path.basename(dbPath)} 失败：${detail}`);
  }
}

async function sqliteExec(dbPath, sql) {
  try {
    await execFileAsync(sqliteBinary, ["-cmd", ".timeout 10000", dbPath, sql], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || error.message;
    throw new Error(`写入 ${path.basename(dbPath)} 失败：${detail}`);
  }
}

async function pathSize(target) {
  try {
    return (await fs.stat(target)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

export async function directorySize(target) {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += await pathSize(full);
  }
  return total;
}

// 官方 ~/.codex 是权威：某窗口的 thread id 只要在这里出现就是副本。
export async function readThreadIndex(homePath) {
  const dbPath = path.join(homePath, "state_5.sqlite");
  try {
    await fs.access(dbPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const rows = await sqliteJSON(dbPath, "select id, rollout_path, updated_at, archived, title from threads");
  const index = new Map();
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (!id) continue;
    index.set(id, {
      id,
      rolloutPath: String(row.rollout_path ?? ""),
      updatedAt: Number(row.updated_at) || 0,
      archived: Number(row.archived) === 1,
      title: String(row.title ?? "").slice(0, 120),
    });
  }
  return index;
}

// 清理目标：续接窗口全量清副本；工作窗口只清「官方已归档」或「超 30 天」的副本。
export async function cleanupTargets(root) {
  const targets = [];
  let names = [];
  try {
    names = (await fs.readdir(path.join(root, continuationSlot))).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const id of names) targets.push({ id, slot: `${continuationSlot}/${id}`, home: path.join(root, continuationSlot, id, "codex-home"), scope: "copies" });
  targets.push({ id: legacyWindowID, slot: "router-v1", home: windowPaths(root, legacyWindowID).homePath, scope: "stale" });
  return targets;
}

// 每个窗口的浏览器缓存目录清单。id 与 parseRunningSlots 保持一致，才能正确跳过正在运行的窗口。
export async function windowCacheTargets(root) {
  const targets = [];
  for (const entry of browserSlots) {
    const dir = path.join(root, entry.slot);
    let names = [];
    if (entry.fixedID) {
      try { await fs.access(dir); names = ["."]; } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      try { names = (await fs.readdir(dir)).sort(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const name of names) {
      const base = entry.fixedID ? dir : path.join(dir, name);
      targets.push({ id: entry.fixedID ?? name, slot: entry.fixedID ? "router-v1" : `${entry.slot}/${name}`, userDataPath: path.join(base, "browser-data") });
    }
  }
  return targets;
}

// 缓存必须是「窗口目录/browser-data 下的白名单子目录」，绝不删 browser-data 本身或白名单之外的东西。
function cacheDirPath(userDataPath, relative) {
  const resolved = path.resolve(userDataPath, relative);
  const rootResolved = path.resolve(userDataPath);
  if (!resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

export async function cachePlan({ root, runningIds = new Set(), onlyIds = null }) {
  const items = [];
  const skipped = [];
  for (const target of await windowCacheTargets(root)) {
    if (onlyIds && !onlyIds.has(target.id)) continue;
    const running = runningIds.has(target.id);
    let bytes = 0;
    let count = 0;
    for (const relative of browserCacheDirs) {
      const dir = cacheDirPath(target.userDataPath, relative);
      if (!dir) continue;
      const size = await directorySize(dir);
      if (size <= 0) continue;
      bytes += size;
      count += 1;
      if (!running) items.push({ windowID: target.id, slot: target.slot, userDataPath: target.userDataPath, dir, relative, bytes: size });
    }
    if (running && count > 0) skipped.push({ id: target.id, reason: "窗口正在运行，等关闭后再清理", copies: 0, bytes });
  }
  return { items, skipped };
}

export function describePlan(plan) {
  return {
    generatedAt: plan.generatedAt,
    staleDays: plan.staleDays,
    reclaimBytes: plan.reclaimBytes,
    // 副本字节必须单独给：reclaimBytes 现在是「副本 + 缓存」的合计，直接复用会把缓存算进副本里。
    items: { count: plan.items.length, bytes: plan.threadBytes ?? plan.reclaimBytes, sample: plan.items.slice(0, 10).map(({ id, title, bytes, reason, windowID }) => ({ id, title, bytes, reason, windowID })) },
    caches: { count: (plan.caches ?? []).length, bytes: plan.cacheBytes ?? 0, sample: (plan.caches ?? []).slice(0, 6).map(({ windowID, relative, bytes }) => ({ windowID, path: relative, bytes })) },
    keepOriginals: plan.keepOriginals,
    windows: plan.windows,
    skipped: plan.skipped,
  };
}

export async function cleanupPlan({ root, officialHome, runningIds = new Set(), now = Date.now(), onlyIds = null, scope = "", includeCaches = true }) {
  const official = await readThreadIndex(officialHome);
  if (!official) throw new Error(`官方任务库不可读：${officialHome}/state_5.sqlite`);
  const officialArchived = new Set([...official.values()].filter((entry) => entry.archived).map((entry) => entry.id));
  const cutoff = staleCutoffSeconds(now);
  const items = [];
  const windows = [];
  const skipped = [];
  const caches = await (includeCaches ? cachePlan({ root, runningIds, onlyIds }) : { items: [], skipped: [] });
  const cacheBytesByWindow = new Map();
  for (const item of caches.items) cacheBytesByWindow.set(item.windowID, (cacheBytesByWindow.get(item.windowID) ?? 0) + item.bytes);
  let keepCount = 0;
  let keepBytes = 0;
  for (const target of await cleanupTargets(root)) {
    if (onlyIds && !onlyIds.has(target.id)) continue;
    const index = await readThreadIndex(target.home);
    if (!index) {
      windows.push({ id: target.id, slot: target.slot, running: false, threads: 0, copies: 0, originals: 0, reclaimBytes: 0, reason: "没有任务库" });
      continue;
    }
    const running = runningIds.has(target.id);
    const targetScope = scope || target.scope;
    let copies = 0;
    let originals = 0;
    let reclaimBytes = 0;
    // 运行中的窗口不能动，但它「关掉后能回收多少」必须算出来：
    // 只说「正在运行」而不给数字，用户没法判断值不值得关掉它再清一次。
    let pendingCount = 0;
    let pendingBytes = 0;
    for (const thread of index.values()) {
      if (!official.has(thread.id)) {
        originals += 1;
        keepCount += 1;
        keepBytes += await pathSize(thread.rolloutPath);
        continue;
      }
      copies += 1;
      const stale = officialArchived.has(thread.id);
      const old = thread.updatedAt > 0 && thread.updatedAt < cutoff;
      if (targetScope === "stale" && !stale && !old) continue;
      const bytes = await pathSize(thread.rolloutPath);
      if (running) {
        pendingCount += 1;
        pendingBytes += bytes;
        continue;
      }
      reclaimBytes += bytes;
      items.push({
        windowID: target.id,
        home: target.home,
        id: thread.id,
        title: thread.title,
        rolloutPath: thread.rolloutPath,
        bytes,
        reason: targetScope === "copies" ? "副本" : stale ? "副本 · 官方已归档" : `副本 · 超 ${staleDays} 天`,
      });
    }
    const cacheBytes = cacheBytesByWindow.get(target.id) ?? 0;
    windows.push({ id: target.id, slot: target.slot, running, threads: index.size, copies, originals, reclaimBytes, cacheBytes, pendingCount, pendingBytes });
    if (running && (pendingCount > 0 || cacheBytes > 0)) {
      skipped.push({ id: target.id, reason: "窗口正在运行，等关闭后再自动清理", copies: pendingCount, bytes: pendingBytes + cacheBytes, copyBytes: pendingBytes, cacheBytes });
    }
  }
  // 同一个窗口的副本与缓存各算过一次，合并成一条「关掉后能回收」的记录，别把缓存的数字覆盖掉副本的。
  for (const entry of caches.skipped) {
    const existing = skipped.find((item) => item.id === entry.id);
    if (!existing) {
      skipped.push({ ...entry, copyBytes: 0, cacheBytes: entry.bytes });
      continue;
    }
    existing.cacheBytes = entry.bytes;
    existing.bytes = (existing.copyBytes ?? 0) + entry.bytes;
  }
  const threadBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const cacheBytes = caches.items.reduce((sum, item) => sum + item.bytes, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    staleDays,
    reclaimBytes: threadBytes + cacheBytes,
    threadBytes,
    cacheBytes,
    items,
    caches: caches.items,
    windows,
    keepOriginals: { count: keepCount, bytes: keepBytes },
    skipped,
  };
}

export async function writeAuditManifest(root, plan, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  const file = path.join(root, cleanupFolder, `${stamp}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicJSON(file, {
    generatedAt: plan.generatedAt,
    appliedAt: new Date().toISOString(),
    reclaimBytes: plan.reclaimBytes,
    items: plan.items.map(({ windowID, id, title, rolloutPath, bytes, reason }) => ({ windowID, id, title, rolloutPath, bytes, reason })),
    caches: (plan.caches ?? []).map(({ windowID, slot, dir, relative, bytes }) => ({ windowID, slot, dir, relative, bytes })),
  });
  return file;
}

// 删除按「文件 → 行 → VACUUM」的顺序走。
// 窗口在跑就不再整体拒绝：正跑着的窗口跳过、其余照清。多开是常态，整体拒绝会让「关掉一个窗口清一次」
// 这种最基本的操作变成不可能（另一个窗口永远在跑）。
export async function applyCleanup({ root, plan, confirm = false, runningIds = new Set() }) {
  if (!confirm) throw new Error("清理会删除会话副本，必须显式确认后才能执行");
  const items = plan.items.filter((item) => !runningIds.has(item.windowID));
  const caches = (plan.caches ?? []).filter((item) => !runningIds.has(item.windowID));
  const skippedRunning = [...new Set(plan.items
    .filter((item) => runningIds.has(item.windowID))
    .map((item) => item.windowID))]
    .map((id) => {
      const group = plan.items.filter((item) => item.windowID === id);
      return { id, threads: group.length, bytes: group.reduce((sum, item) => sum + item.bytes, 0) };
    });
  const effective = { ...plan, items, caches };
  if (!items.length && !caches.length) {
    return { deletedFiles: 0, deletedThreads: 0, deletedCacheDirs: 0, freedBytes: 0, backupManifest: null, windows: [], skippedRunning };
  }
  const manifest = await writeAuditManifest(root, effective);
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.home)) grouped.set(item.home, []);
    grouped.get(item.home).push(item);
  }
  let deletedFiles = 0;
  let freedBytes = 0;
  const windows = [];
  for (const [home, group] of grouped) {
    const before = await directorySize(home);
    for (const item of group) {
      if (!item.rolloutPath) continue;
      try {
        await fs.rm(item.rolloutPath, { force: true });
        deletedFiles += 1;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const ids = group.map((item) => quote(item.id)).join(",");
    await sqliteExec(path.join(home, "state_5.sqlite"), [
      `delete from thread_attachments where thread_id in (${ids});`,
      `delete from thread_dynamic_tools where thread_id in (${ids});`,
      `delete from threads where id in (${ids});`,
      "vacuum;",
    ].join("\n"));
    const history = path.join(home, "thread_history_1.sqlite");
    try {
      await fs.access(history);
      await sqliteExec(history, [
        `delete from thread_items where thread_id in (${ids});`,
        `delete from thread_turns where thread_id in (${ids});`,
        `delete from thread_realtime_items where thread_id in (${ids});`,
        "vacuum;",
      ].join("\n"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const after = await directorySize(home);
    freedBytes += Math.max(0, before - after);
    windows.push({ id: group[0].windowID, home, threads: group.length, beforeBytes: before, afterBytes: after });
  }
  let deletedCacheDirs = 0;
  for (const item of caches) {
    // 落盘前再自校验一次：路径必须正好是「browser-data + 白名单相对路径」，白名单外一律不动。
    const expected = item.userDataPath ? cacheDirPath(item.userDataPath, item.relative) : null;
    if (!expected || expected !== path.resolve(item.dir)) continue;
    const before = await directorySize(item.dir);
    try {
      await fs.rm(item.dir, { recursive: true, force: true });
      deletedCacheDirs += 1;
      freedBytes += before;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { deletedFiles, deletedThreads: items.length, deletedCacheDirs, freedBytes, backupManifest: manifest, windows, skippedRunning };
}

// 窗口启动前的一次自动清理：此刻 Codex 还没打开它的任务库，读写不会互相打架。
// 只清「官方已归档」或「超 30 天」的副本（原件在官方库里，随时能再导入），并且只清这一个窗口。
export async function cleanupWindowOnLaunch({ root, officialHome, windowID, home, runningIds = new Set(), now = Date.now(), policy = {} }) {
  if (policy.autoCleanupOnLaunch === false) return { skipped: "已在设置里关闭启动前自动清理" };
  if (runningIds.has(windowID)) return { skipped: "窗口已在运行" };
  const onlyIds = new Set([windowID]);
  const plan = await cleanupPlan({ root, officialHome, runningIds, now, onlyIds, scope: "stale", includeCaches: policy.pruneBrowserCache !== false });
  if (!plan.items.length && !plan.caches.length) return { deletedThreads: 0, deletedCacheDirs: 0, freedBytes: 0, reclaimBytes: 0, home };
  const result = await applyCleanup({ root, plan, confirm: true, runningIds });
  return {
    home,
    deletedThreads: result.deletedThreads,
    deletedFiles: result.deletedFiles,
    deletedCacheDirs: result.deletedCacheDirs,
    freedBytes: result.freedBytes,
    backupManifest: result.backupManifest,
    reasons: [...new Set(plan.items.map((item) => item.reason))],
  };
}

export async function systemDisk(mount = "/") {
  try {
    const { stdout } = await execFileAsync("/bin/df", ["-k", mount], { maxBuffer: 1024 * 1024 });
    const line = String(stdout ?? "").trim().split("\n").at(-1) ?? "";
    const columns = line.split(/\s+/);
    const total = Number(columns[1]) * 1024;
    const free = Number(columns[3]) * 1024;
    const used = Number(columns[2]) * 1024;
    // 分母必须用「1K-blocks」那一列，不能用 used + free：
    // APFS 一个容器里多个卷共享空间，df 只报本卷已用，used + free 会远小于真实容量，
    // 「剩余百分比」于是被算成 80% 这种假象，而真实只剩 10%。
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
      return { totalBytes: total, usedBytes: used, freeBytes: free, freePercent: Math.min(100, (free / total) * 100) };
    }
  } catch { }
  const stats = await fs.statfs(mount);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { totalBytes: total, usedBytes: (stats.blocks - stats.bfree) * stats.bsize, freeBytes: free, freePercent: total > 0 ? (free / total) * 100 : 100 };
}

export async function diskUsage({ root, plan, mount = "/" }) {
  const [totalBytes, disk] = await Promise.all([directorySize(root), systemDisk(mount)]);
  return {
    totalBytes,
    perWindow: plan.windows,
    reclaimable: plan.reclaimBytes,
    keepOriginals: plan.keepOriginals,
    freeDiskPercent: disk.freePercent,
    freeDiskBytes: disk.freeBytes,
    diskTotalBytes: disk.totalBytes,
  };
}

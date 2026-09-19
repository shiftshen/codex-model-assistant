import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJSON } from "./model-store.mjs";
import { legacyWindowID, windowPaths } from "./window-registry.mjs";
import { isWindows, platformDiskRoot, runCommandWithInput, sqliteExecutable, tarExecutable } from "./platform-runtime.mjs";

const execFileAsync = promisify(execFile);
const sqliteBinary = () => sqliteExecutable();

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
    const { stdout } = await runCommandWithInput(sqliteBinary(), ["-cmd", ".timeout 10000", "-json", dbPath], sql, { maxBuffer: 64 * 1024 * 1024 });
    const text = String(stdout ?? "").trim();
    return text ? JSON.parse(text) : [];
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || error.message;
    throw new Error(`读取 ${path.basename(dbPath)} 失败：${detail}`);
  }
}

async function sqliteExec(dbPath, sql) {
  try {
    await runCommandWithInput(sqliteBinary(), ["-cmd", ".timeout 10000", dbPath], sql, { maxBuffer: 16 * 1024 * 1024 });
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

export async function writeAuditManifest(root, plan, stamp = new Date().toISOString().replace(/[:.]/g, "-"), { kind = "window-copies" } = {}) {
  const file = path.join(root, cleanupFolder, `${stamp}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicJSON(file, {
    kind,
    generatedAt: plan.generatedAt,
    appliedAt: new Date().toISOString(),
    reclaimBytes: plan.reclaimBytes,
    items: plan.items.map(({ windowID, id, title, rolloutPath, bytes, reason }) => ({ windowID, id, title, rolloutPath, bytes, reason })),
    caches: (plan.caches ?? []).map(({ windowID, slot, dir, relative, bytes }) => ({ windowID, slot, dir, relative, bytes })),
  });
  return file;
}

// 「文件 → 行 → VACUUM」这条顺序单独抽出来：窗口副本和官方库归档会话删的是同一批表，
// 分开写两份迟早会漂移（一份改了、另一份忘了改，就是静默的半删状态）。
async function purgeThreads(home, items) {
  const before = await directorySize(home);
  let deletedFiles = 0;
  for (const item of items) {
    if (!item.rolloutPath) continue;
    try {
      await fs.rm(item.rolloutPath, { force: true });
      deletedFiles += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const ids = items.map((item) => quote(item.id)).join(",");
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
  return { deletedFiles, freedBytes: Math.max(0, before - after), beforeBytes: before, afterBytes: after };
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
    const purged = await purgeThreads(home, group);
    deletedFiles += purged.deletedFiles;
    freedBytes += purged.freedBytes;
    windows.push({ id: group[0].windowID, home, threads: group.length, beforeBytes: purged.beforeBytes, afterBytes: purged.afterBytes });
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

// —— 官方库「已归档会话」清理 ——
// 这是唯一会改动 ~/.codex 的操作，和窗口副本清理性质不同：
// 窗口里的副本删了还能从官方库再导入一份，官方库删了就没有第二份了（不可恢复）。
// 所以三条硬规矩：必须显式确认、ChatGPT Desktop（官方）没在运行时才允许、只清 archived=1。
// olderThanDays 为 null 时只选「已归档」；给了天数就再加「超过 N 天没动过」。
// 后者删的是用户没归档、但很旧的历史，风险明显更高，所以调用方必须显式传天数。
export async function officialArchivedPlan({ officialHome, olderThanDays = null, now = Date.now() }) {
  const index = await readThreadIndex(officialHome);
  if (!index) throw new Error(`官方任务库不可读：${path.join(officialHome, "state_5.sqlite")}`);
  const cutoff = olderThanDays === null ? null : Math.floor(now / 1000) - olderThanDays * 86400;
  const items = [];
  for (const thread of index.values()) {
    const old = cutoff !== null && thread.updatedAt > 0 && thread.updatedAt < cutoff;
    if (!thread.archived && !old) continue;
    items.push({
      windowID: "official",
      home: officialHome,
      id: thread.id,
      title: thread.title,
      rolloutPath: thread.rolloutPath,
      bytes: await pathSize(thread.rolloutPath),
      reason: thread.archived ? "官方库 · 已归档" : `官方库 · 超 ${olderThanDays} 天`,
      updatedAt: thread.updatedAt,
    });
  }
  return {
    kind: "official-archived",
    generatedAt: new Date().toISOString(),
    officialHome,
    olderThanDays,
    items,
    reclaimBytes: items.reduce((sum, item) => sum + item.bytes, 0),
  };
}

// 原件删掉就没有第二份，所以「按时间清旧会话」默认先把 rollout 打包成一个 tar.gz 再删：
// JSONL 压缩比通常 5–10 倍，占用大幅下降，但内容还在，日后能解包找回。
export async function archiveRollouts({ items, archiveDir, officialHome, stamp = new Date().toISOString().replace(/[:.]/g, "-") }) {
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const file = path.join(archiveDir, `official-archive-${stamp}.tar.gz`);
  const root = path.resolve(officialHome);
  // 存相对路径：解包出来直接就是 sessions/… 的原样结构，不用再猜绝对路径里的层级。
  const list = items
    .filter((item) => item.rolloutPath)
    .map((item) => {
      const resolved = path.resolve(item.rolloutPath);
      return resolved.startsWith(root + path.sep) ? path.relative(root, resolved) : resolved;
    });
  if (!list.length) return null;
  const listFile = path.join(archiveDir, `.list-${stamp}.txt`);
  await fs.writeFile(listFile, list.join("\n") + "\n", { mode: 0o600 });
  try {
    await execFileAsync(tarExecutable(), ["-czf", file, "-C", root, "-T", listFile], { maxBuffer: 32 * 1024 * 1024 });
  } finally {
    await fs.rm(listFile, { force: true });
  }
  const bytes = await pathSize(file);
  await fs.writeFile(`${file}.txt`, [
    `来源官方库：${officialHome}`,
    `条目数：${items.length}`,
    `打包时间：${new Date().toISOString()}`,
    "解包：tar -xzf 本文件 -C <目标目录>，得到原始 rollout .jsonl（可重新导入 Codex）",
  ].join("\n") + "\n", { mode: 0o600 });
  return { file, bytes, count: items.length };
}

export async function applyOfficialArchived({ root, officialHome, plan, confirm = false, officialRunning = false, archiveDir = "" }) {
  if (!confirm) throw new Error("官方库的会话没有第二份，删除不可恢复，必须显式确认后才能执行");
  if (officialRunning) throw new Error("ChatGPT Desktop（官方）正在运行，拒绝清理官方库：请先退出官方窗口再试");
  if (!plan.items.length) return { deletedFiles: 0, deletedThreads: 0, freedBytes: 0, beforeBytes: 0, afterBytes: 0, backupManifest: null };
  const archive = archiveDir ? await archiveRollouts({ items: plan.items, archiveDir, officialHome }) : null;
  const manifest = await writeAuditManifest(root, plan, undefined, { kind: "official-archived" });
  const purged = await purgeThreads(officialHome, plan.items);
  return {
    deletedFiles: purged.deletedFiles,
    deletedThreads: plan.items.length,
    freedBytes: purged.freedBytes,
    archive,
    beforeBytes: purged.beforeBytes,
    afterBytes: purged.afterBytes,
    backupManifest: manifest,
  };
}

export async function systemDisk(mount = "/") {
  const target = isWindows ? await platformDiskRoot(mount) : mount;
  if (!isWindows) {
    try {
      const { stdout } = await execFileAsync("/bin/df", ["-k", target], { maxBuffer: 1024 * 1024 });
      const line = String(stdout ?? "").trim().split("\n").at(-1) ?? "";
      const columns = line.split(/\s+/);
      const total = Number(columns[1]) * 1024;
      const free = Number(columns[3]) * 1024;
      const used = Number(columns[2]) * 1024;
      if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
        return { totalBytes: total, usedBytes: used, freeBytes: free, freePercent: Math.min(100, (free / total) * 100) };
      }
    } catch { }
  }
  const stats = await fs.statfs(target);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { totalBytes: total, usedBytes: (stats.blocks - stats.bfree) * stats.bsize, freeBytes: free, freePercent: total > 0 ? (free / total) * 100 : 100 };
}

// 本地 Time Machine 快照会钉住刚删掉的文件的磁盘块：清理报告说释放了 5 GB，
// 但 df 一动不动，用户会以为清理坏了。删快照要管理员密码，所以这里只如实报数量。
export async function localSnapshotCount() {
  if (isWindows) return 0;
  try {
    const { stdout } = await execFileAsync("/usr/bin/tmutil", ["listlocalsnapshots", "/"], { timeout: 15000 });
    return String(stdout).split("\n").filter((line) => line.includes(".local")).length;
  } catch {
    return 0;
  }
}

export async function diskUsage({ root, plan, mount = "/" }) {
  const [totalBytes, disk, snapshots] = await Promise.all([directorySize(root), systemDisk(mount), localSnapshotCount()]);
  return {
    localSnapshots: snapshots,
    totalBytes,
    perWindow: plan.windows,
    reclaimable: plan.reclaimBytes,
    keepOriginals: plan.keepOriginals,
    freeDiskPercent: disk.freePercent,
    freeDiskBytes: disk.freeBytes,
    diskTotalBytes: disk.totalBytes,
  };
}

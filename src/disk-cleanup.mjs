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

export function describePlan(plan) {
  return {
    generatedAt: plan.generatedAt,
    staleDays: plan.staleDays,
    reclaimBytes: plan.reclaimBytes,
    items: { count: plan.items.length, bytes: plan.reclaimBytes, sample: plan.items.slice(0, 10).map(({ id, title, bytes, reason, windowID }) => ({ id, title, bytes, reason, windowID })) },
    keepOriginals: plan.keepOriginals,
    windows: plan.windows,
    skipped: plan.skipped,
  };
}

export async function cleanupPlan({ root, officialHome, runningIds = new Set(), now = Date.now() }) {
  const official = await readThreadIndex(officialHome);
  if (!official) throw new Error(`官方任务库不可读：${officialHome}/state_5.sqlite`);
  const officialArchived = new Set([...official.values()].filter((entry) => entry.archived).map((entry) => entry.id));
  const cutoff = staleCutoffSeconds(now);
  const items = [];
  const windows = [];
  const skipped = [];
  let keepCount = 0;
  let keepBytes = 0;
  for (const target of await cleanupTargets(root)) {
    const index = await readThreadIndex(target.home);
    if (!index) {
      windows.push({ id: target.id, slot: target.slot, running: false, threads: 0, copies: 0, originals: 0, reclaimBytes: 0, reason: "没有任务库" });
      continue;
    }
    const running = runningIds.has(target.id);
    let copies = 0;
    let originals = 0;
    let reclaimBytes = 0;
    for (const thread of index.values()) {
      if (!official.has(thread.id)) {
        originals += 1;
        keepCount += 1;
        keepBytes += await pathSize(thread.rolloutPath);
        continue;
      }
      copies += 1;
      if (running) continue;
      const stale = officialArchived.has(thread.id);
      const old = thread.updatedAt > 0 && thread.updatedAt < cutoff;
      if (target.scope === "stale" && !stale && !old) continue;
      const bytes = await pathSize(thread.rolloutPath);
      reclaimBytes += bytes;
      items.push({
        windowID: target.id,
        home: target.home,
        id: thread.id,
        title: thread.title,
        rolloutPath: thread.rolloutPath,
        bytes,
        reason: target.scope === "copies" ? "副本" : stale ? "副本 · 官方已归档" : `副本 · 超 ${staleDays} 天`,
      });
    }
    windows.push({ id: target.id, slot: target.slot, running, threads: index.size, copies, originals, reclaimBytes });
    if (running && copies > 0) skipped.push({ id: target.id, reason: "窗口正在运行，等关闭后再清理", copies, bytes: 0 });
  }
  return {
    generatedAt: new Date(now).toISOString(),
    staleDays,
    reclaimBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    items,
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
  });
  return file;
}

// 删除按「文件 → 行 → VACUUM」的顺序走；窗口在跑就整体拒绝，绝不半途而动。
export async function applyCleanup({ root, plan, confirm = false, runningIds = new Set() }) {
  if (!confirm) throw new Error("清理会删除会话副本，必须显式确认后才能执行");
  const busy = [...new Set(plan.items.map((item) => item.windowID))].filter((id) => runningIds.has(id));
  if (busy.length) throw new Error(`窗口 ${busy.join("、")} 正在运行，拒绝清理`);
  if (!plan.items.length) return { deletedFiles: 0, deletedThreads: 0, freedBytes: 0, backupManifest: null, windows: [] };
  const manifest = await writeAuditManifest(root, plan);
  const grouped = new Map();
  for (const item of plan.items) {
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
  return { deletedFiles, deletedThreads: plan.items.length, freedBytes, backupManifest: manifest, windows };
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

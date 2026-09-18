#!/usr/bin/env node
// /Applications 里只应该有一个「Codex 模型助手」。历史上每次安装都会在同一个目录留下
// 一份 .backup-* 副本，Finder 里就变成一排文件夹。这里负责：
//   1) 清掉 /Applications 里历史遗留的 .backup-* 目录；
//   2) 把真正的备份目录裁剪到最近 keep 份。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function entries(directory) {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// 失效(旧)的条目 = 排序后、去掉最后 keep 个剩下的那些；返回被删掉的完整路径。
export async function pruneDirectory(directory, { keep = 2, match = () => true, dryRun = false } = {}) {
  const names = (await entries(directory)).filter((name) => match(name));
  const stale = keep <= 0 ? names : names.slice(0, Math.max(0, names.length - keep));
  const removed = [];
  for (const name of stale) {
    const full = path.join(directory, name);
    if (!dryRun) await fs.rm(full, { recursive: true, force: true });
    removed.push(full);
  }
  return removed;
}

export async function pruneAppBackups({ appPath, backupDir, keep = 2, dryRun = false }) {
  const appName = path.basename(appPath);
  // 备份目录里存的是完整应用包：「Codex 模型助手-<时间戳>.app」，所以按去掉 .app 的名字匹配。
  const appStem = appName.replace(/\.app$/, "");
  const leftovers = await pruneDirectory(path.dirname(appPath), {
    keep: 0,
    match: (name) => name.startsWith(`${appName}.backup-`),
    dryRun,
  });
  const trimmed = await pruneDirectory(backupDir, {
    keep,
    match: (name) => name.startsWith(`${appStem}-`) && name.endsWith(".app"),
    dryRun,
  });
  return { leftovers, trimmed, dryRun };
}

// 直接当命令跑时才执行；被 import 时不执行（argv[1] 可能是相对路径，必须解析成绝对路径再比）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2] || "/Applications/Codex 模型助手.app";
  const backupDir = process.argv[3] || path.join(process.env.HOME ?? "", ".codex/model-assistant/backups");
  const result = await pruneAppBackups({ appPath, backupDir, keep: Number(process.argv[4] || 2) });
  process.stdout.write(`清理遗留备份 ${result.leftovers.length} 个，裁剪备份目录 ${result.trimmed.length} 个\n`);
}

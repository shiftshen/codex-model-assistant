import fs from "node:fs/promises";
import path from "node:path";
import { atomicJSON } from "./model-store.mjs";

// 磁盘策略：默认「窗口启动前自动清掉不重要的副本 + 顺手清浏览器缓存」。
// 删除范围写死在 disk-cleanup 里（只清官方已归档或超 30 天的副本，且只清副本），这里只控制开关。
export const defaultDiskPolicy = Object.freeze({
  revision: 1,
  autoCleanupOnLaunch: true,
  pruneBrowserCache: true,
});

export function validateDiskPolicy(input) {
  if (!Number.isInteger(input?.revision) || input.revision < 1) throw new Error("磁盘策略版本无效");
  const policy = { revision: input.revision };
  for (const field of ["autoCleanupOnLaunch", "pruneBrowserCache"]) {
    if (typeof input[field] !== "boolean") throw new Error(`${field} 只能是 true 或 false`);
    policy[field] = input[field];
  }
  return policy;
}

export async function readDiskPolicy(store) {
  const file = path.join(store.root, "disk-policy.json");
  await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
  try { return validateDiskPolicy(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await fs.writeFile(file, JSON.stringify(defaultDiskPolicy, null, 2), { mode: 0o600, flag: "wx" }); }
    catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; return readDiskPolicy(store); }
    return { ...defaultDiskPolicy };
  }
}

export async function saveDiskPolicy(store, input) {
  const current = await readDiskPolicy(store);
  const next = validateDiskPolicy({ ...input, revision: current.revision });
  next.revision = current.revision + 1;
  await atomicJSON(path.join(store.root, "disk-policy.json"), next);
  return next;
}

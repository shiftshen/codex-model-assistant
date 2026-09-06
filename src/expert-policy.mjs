import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON } from "./model-store.mjs";

export const localCallers = Object.freeze(["s5090-ornith", "s5090-qwen"]);
export const defaultExpertPolicy = Object.freeze({
  revision: 1, mode: "on_demand", preferredLocal: "s5090-ornith", expertRoute: "deepseek-flash",
  dailyCalls: 6, callerDailyCalls: 3, cooldownSeconds: 90, maxInputChars: 12000, maxOutputTokens: 1500,
});

export function validateExpertPolicy(input) {
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("专家策略版本无效");
  if (!["on_demand", "manual_only", "disabled"].includes(input.mode)) throw new Error("专家模式无效");
  if (!localCallers.includes(input.preferredLocal)) throw new Error("主力模型必须为 Ornith 或 Qwen 本地入口");
  if (typeof input.expertRoute !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.expertRoute)) throw new Error("专家模型标识无效");
  const policy = { revision: input.revision, mode: input.mode, preferredLocal: input.preferredLocal, expertRoute: input.expertRoute };
  for (const [field, min, max] of [["dailyCalls", 1, 100], ["callerDailyCalls", 1, 50], ["cooldownSeconds", 0, 3600], ["maxInputChars", 500, 24000], ["maxOutputTokens", 128, 4096]]) {
    if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) throw new Error(`${field} 应在 ${min}–${max} 之间`);
    policy[field] = input[field];
  }
  if (policy.callerDailyCalls > policy.dailyCalls) throw new Error("单个本地模型额度不能超过总额度");
  return policy;
}

export async function readExpertPolicy(store) {
  const file = path.join(store.root, "expert-policy.json");
  await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
  try { return validateExpertPolicy(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await fs.writeFile(file, JSON.stringify(defaultExpertPolicy, null, 2), { mode: 0o600, flag: "wx" }); }
    catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; return readExpertPolicy(store); }
    return { ...defaultExpertPolicy };
  }
}

export async function saveExpertPolicy(store, input) {
  const next = validateExpertPolicy(input);
  if (next.mode !== "disabled") {
    const target = await store.route(next.expertRoute);
    if (target.protocol === "oauth" || target.noKey || target.archived || !target.model) throw new Error("请选择已配置的 API 专家模型，不能使用 ChatGPT 登录或本地主力作为付费专家");
    if (!(await store.secret(target.credentialID))) throw new Error("请先为专家模型配置 API Key");
  }
  const lockPath = path.join(store.root, "expert-policy.lock");
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("专家策略正在保存，请稍后重试"); throw error; }
  try {
    const current = await readExpertPolicy(store);
    if (current.revision !== input.revision) throw new Error("专家策略已被更新，请刷新后重试");
    next.revision = current.revision + 1;
    await atomicJSON(path.join(store.root, "backups", `expert-policy-${randomUUID()}.json`), current);
    await atomicJSON(path.join(store.root, "expert-policy.json"), next);
    return next;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

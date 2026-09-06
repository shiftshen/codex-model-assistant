import fs from "node:fs/promises";
import path from "node:path";

import { renderConfig } from "./route-config.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function atomicWrite(filePath, content, mode) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.model-assistant-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(temporaryPath, content, { mode });
  await fs.rename(temporaryPath, filePath);
}

export async function applyRoute(routeId, options) {
  const configPath = options.configPath;
  const backupDirectory = options.backupDirectory;
  const validate = options.validate;
  const original = await fs.readFile(configPath, "utf8");
  const stat = await fs.stat(configPath);
  const rendered = renderConfig(original, routeId);

  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDirectory, `config-${timestamp()}-${routeId}.toml`);
  await fs.writeFile(backupPath, original, { mode: 0o600 });
  await atomicWrite(configPath, rendered, stat.mode);

  const validation = await validate(configPath);
  if (!validation.ok) {
    await atomicWrite(configPath, original, stat.mode);
    throw new Error(validation.message || "Codex configuration validation failed");
  }

  return { routeId, backupPath };
}

export async function checkModelsEndpoint({
  endpoint,
  model,
  token,
  timeoutMs = 5_000,
}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    const models = Array.isArray(body?.data) ? body.data.map((entry) => entry.id) : [];
    if (!models.includes(model)) {
      return { ok: false, message: `端点未返回目标模型 ${model}`, models };
    }
    return { ok: true, message: "连接正常", models };
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "连接超时" : error.message;
    return { ok: false, message };
  }
}

async function ensureSharedLink(source, destination) {
  try {
    const sourceStat = await fs.stat(source);
    const type = sourceStat.isDirectory() ? "dir" : "file";
    try {
      const destinationStat = await fs.lstat(destination);
      if (destinationStat.isSymbolicLink() && (await fs.readlink(destination)) === source) {
        return;
      }
      throw new Error(`Instance asset already exists and is not managed: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.symlink(source, destination, type);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensureLocalDirectory(destination) {
  try {
    const destinationStat = await fs.lstat(destination);
    if (destinationStat.isDirectory() && !destinationStat.isSymbolicLink()) return;
    if (!destinationStat.isSymbolicLink()) {
      throw new Error(`Instance asset already exists and is not managed: ${destination}`);
    }
    await fs.unlink(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
}

export async function prepareInstance(routeId, options) {
  const sharedHome = options.sharedHome;
  const instanceRoot = options.instanceRoot;
  const routeRoot = path.join(instanceRoot, routeId);
  const homePath = path.join(routeRoot, "codex-home");
  const userDataPath = path.join(routeRoot, "browser-data");
  const sharedConfigPath = path.join(sharedHome, "config.toml");
  const configPath = path.join(homePath, "config.toml");

  const sharedConfig = await fs.readFile(sharedConfigPath, "utf8");
  const rendered = renderConfig(sharedConfig, routeId);
  await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await atomicWrite(configPath, rendered, 0o600);

  for (const name of ["auth.json", "skills", "plugins", "requirements.toml", "hooks.json"]) {
    await ensureSharedLink(path.join(sharedHome, name), path.join(homePath, name));
  }
  await ensureLocalDirectory(path.join(homePath, "memories"));

  return { routeId, routeRoot, homePath, userDataPath, configPath };
}

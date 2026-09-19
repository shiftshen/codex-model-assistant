import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  applyRoute,
  checkModelsEndpoint,
  prepareInstance,
} from "../src/route-manager-lib.mjs";

async function temporaryWorkspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-route-test-"));
  const configPath = path.join(directory, "config.toml");
  const backupDirectory = path.join(directory, "backups");
  await fs.writeFile(configPath, 'model = "gpt-6-astra"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  return { directory, configPath, backupDirectory };
}

test("applies a route atomically and creates a backup", async () => {
  const workspace = await temporaryWorkspace();
  const result = await applyRoute("agnes", {
    configPath: workspace.configPath,
    backupDirectory: workspace.backupDirectory,
    validate: async () => ({ ok: true }),
  });

  const current = await fs.readFile(workspace.configPath, "utf8");
  const backup = await fs.readFile(result.backupPath, "utf8");
  assert.match(current, /^model_provider = "agnes"$/m);
  assert.match(backup, /^model = "gpt-6-astra"$/m);
  assert.equal(result.routeId, "agnes");
});

test("restores the original config when validation fails", async () => {
  const workspace = await temporaryWorkspace();
  const original = await fs.readFile(workspace.configPath, "utf8");

  await assert.rejects(
    applyRoute("agnes", {
      configPath: workspace.configPath,
      backupDirectory: workspace.backupDirectory,
      validate: async () => ({ ok: false, message: "invalid config" }),
    }),
    /invalid config/,
  );

  assert.equal(await fs.readFile(workspace.configPath, "utf8"), original);
});

test("model endpoint check verifies the selected model", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "wanted-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const success = await checkModelsEndpoint({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "wanted-model",
      timeoutMs: 1_000,
    });
    const missing = await checkModelsEndpoint({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "missing-model",
      timeoutMs: 1_000,
    });

    assert.equal(success.ok, true);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /missing-model/);
  } finally {
    server.close();
  }
});

test("prepares an isolated route home without changing the shared config", async () => {
  const workspace = await temporaryWorkspace();
  const sharedHome = path.join(workspace.directory, "shared-home");
  const instanceRoot = path.join(workspace.directory, "instances");
  await fs.mkdir(path.join(sharedHome, "skills"), { recursive: true });
  await fs.mkdir(path.join(sharedHome, "memories"), { recursive: true });
  await fs.writeFile(path.join(sharedHome, "auth.json"), '{"auth_mode":"chatgpt"}\n');
  await fs.writeFile(path.join(sharedHome, "AGENTS.md"), "# Global smart-development rules\n");
  await fs.copyFile(workspace.configPath, path.join(sharedHome, "config.toml"));
  const original = await fs.readFile(path.join(sharedHome, "config.toml"), "utf8");

  const result = await prepareInstance("deepseek-pro", {
    sharedHome,
    instanceRoot,
  });

  const isolatedConfig = await fs.readFile(result.configPath, "utf8");
  assert.match(isolatedConfig, /^model_provider = "deepseek-official"$/m);
  assert.match(isolatedConfig, /^model = "deepseek-v4-pro"$/m);
  assert.equal(await fs.readFile(path.join(sharedHome, "config.toml"), "utf8"), original);
  assert.equal((await fs.lstat(path.join(result.homePath, "auth.json"))).isSymbolicLink(), true);
  assert.equal((await fs.lstat(path.join(result.homePath, "skills"))).isSymbolicLink(), true);
  assert.equal((await fs.lstat(path.join(result.homePath, "AGENTS.md"))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(result.homePath, "AGENTS.md"), "utf8"), "# Global smart-development rules\n");
  assert.equal((await fs.lstat(path.join(result.homePath, "memories"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(result.homePath, "memories"))).isSymbolicLink(), false);
  assert.equal(result.userDataPath, path.join(instanceRoot, "deepseek-pro", "browser-data"));
});

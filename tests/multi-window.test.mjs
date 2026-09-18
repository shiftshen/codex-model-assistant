import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService } from "../src/product-service.mjs";
import { toAnthropic, sanitizeAnthropicSchema } from "../src/protocol-adapter.mjs";
import { readWindowRegistry, windowPaths, writeWindowRegistry } from "../src/window-registry.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-multi-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

async function withWindows(store) {
  const registry = await readWindowRegistry(store.root);
  await writeWindowRegistry(store.root, {
    ...registry,
    windows: [
      ...registry.windows,
      { id: "w2", name: "窗口 2", initialModel: "deepseek-flash", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "w3", name: "窗口 3", initialModel: "agnes", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
}

function commandFor(store, id) {
  return `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${windowPaths(store.root, id).userDataPath}`;
}

// Anthropic 只接受字符串 enum；Codex 的工具 schema 里带数字 enum，原样转发会让整个请求 400。
test("转换 Anthropic 工具 schema：丢掉非字符串 enum，保留字符串 enum", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      count: { type: "integer", enum: [0, 1] },
      nested: { type: "object", properties: { flag: { type: "boolean", enum: [true, false] } } },
    },
    required: ["mode"],
    additionalProperties: false,
  };
  const clean = sanitizeAnthropicSchema(schema);
  assert.deepEqual(clean.properties.mode.enum, ["fast", "slow"]);
  assert.equal(clean.properties.count.enum, undefined);
  assert.equal(clean.properties.count.type, "integer");
  assert.equal(clean.properties.nested.properties.flag.enum, undefined);
  assert.deepEqual(clean.required, ["mode"]);
  assert.equal(clean.additionalProperties, false);
  // 原始输入不能被就地改写
  assert.deepEqual(schema.properties.count.enum, [0, 1]);
});

test("toAnthropic 的工具里不再出现非字符串 enum", () => {
  const body = toAnthropic({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: {
        name: "shell",
        description: "run",
        parameters: { type: "object", properties: { timeout: { type: "number", enum: [0, 1] }, mode: { type: "string", enum: ["a"] } } },
      },
    }],
  });
  const collected = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum") collected.push(...value);
      walk(value);
    }
  };
  walk(body.tools);
  assert.ok(collected.length > 0);
  assert.ok(collected.every((entry) => typeof entry === "string"), `应全是字符串：${JSON.stringify(collected)}`);
  assert.deepEqual(body.tools[0].input_schema.properties.mode.enum, ["a"]);
});

test("关窗只认目标窗口自己的进程，PID 不匹配就拒绝", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);

  service.windowProcessCommand = async () => commandFor(store, "w2");
  assert.equal(await service.assertWindowProcess(4242, "w2"), true);
  await assert.rejects(() => service.assertWindowProcess(4242, "w3"), /不是「w3」窗口的进程/);

  // 进程已经退出：返回 false，由调用方按「没在运行」处理
  service.windowProcessCommand = async () => "";
  assert.equal(await service.assertWindowProcess(4242, "w2"), false);
});

test("多开时关窗不会误伤别的窗口和助手自己", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["w2", 4242]]);
  // 命令行是 w3 的：说明 pid 归属对不上，必须拒绝而不是照杀
  service.windowProcessCommand = async () => commandFor(store, "w3");
  await assert.rejects(() => service.closeWindow("w2"), /不是「w2」窗口的进程/);

  await assert.rejects(() => service.killWindowProcess(process.pid), /拒绝结束助手自身的进程/);
  await assert.rejects(() => service.killWindowProcess(0), /进程号无效/);
});

test("每个窗口的运行判定互相独立", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["w2", 11], ["w3", 22]]);
  const summary = await service.switchSummary();
  const byID = new Map(summary.windows.map((entry) => [entry.id, entry]));
  assert.equal(byID.get("w2").pid, 11);
  assert.equal(byID.get("w3").pid, 22);
  assert.equal(byID.get("router").running, false);
});

test("只有该窗口自己有进程时，ID 校验才通过（router 用 router-v1 目录）", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  service.windowProcessCommand = async () => `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${windowPaths(store.root, "router").userDataPath}`;
  assert.equal(await service.assertWindowProcess(99, "router"), true);
  await assert.rejects(() => service.assertWindowProcess(99, "w2"), /不是「w2」窗口的进程/);
});

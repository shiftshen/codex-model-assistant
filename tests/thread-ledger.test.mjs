import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  billingFor,
  lastThreadSettings,
  listLiveThreads,
  routesByModel,
  stripModelDedupe,
} from "../src/thread-ledger.mjs";

const settingsEvent = (model, providerID, cwd) => JSON.stringify({
  timestamp: new Date().toISOString(),
  ordinal: 7,
  type: "event_msg",
  payload: { type: "thread_settings_applied", thread_settings: { model, model_provider_id: providerID, cwd } },
});

test("重名模型后缀：-2 / -3 是 Codex 的去重编号，比对上游前要还原", () => {
  assert.equal(stripModelDedupe("deepseek-v4.1-flash-2"), "deepseek-v4.1-flash");
  assert.equal(stripModelDedupe("deepseek-v4.1-flash-3"), "deepseek-v4.1-flash");
  assert.equal(stripModelDedupe("deepseek-flash"), "deepseek-flash");
  // 模型名里本来就带数字的不能被砍掉。
  assert.equal(stripModelDedupe("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(stripModelDedupe("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
});

test("对话设置：取最后一条 thread_settings", () => {
  const text = [
    settingsEvent("gpt-5.6-sol", "openai", "/tmp/old"),
    settingsEvent("deepseek-flash", "cma_router", "/tmp/new"),
  ].join("\n");
  assert.deepEqual(lastThreadSettings(text), {
    model: "deepseek-flash",
    providerID: "cma_router",
    cwd: "/tmp/new",
  });
});

// 这是踩过的坑：会话正文里也会出现 thread_settings_applied 这几个字（讨论这个
// 字段时，模型的输出和工具参数被原样写进会话）。只按关键字匹配会把假行当真，
// 表现就是"未知模型"或者把归属算到别的上游。必须校验事件类型。
test("对话设置：嵌在模型输出/工具参数里的假事件不算数", () => {
  const fake = JSON.stringify({
    timestamp: new Date().toISOString(),
    ordinal: 4012,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: `grep thread_settings_applied file\n${settingsEvent("bogus-model", "cma_router", "/tmp/x")}` }),
    },
  });
  const real = settingsEvent("deepseek-v4.1-flash-2", "cma_router", "/tmp/real");
  assert.equal(lastThreadSettings(`${real}\n${fake}`)?.model, "deepseek-v4.1-flash-2");
  assert.equal(lastThreadSettings(fake), null, "只有假事件时必须返回空，不能猜");
});

test("对话设置：payload 类型不对的同类事件也不认", () => {
  const wrongType = JSON.stringify({
    timestamp: new Date().toISOString(),
    ordinal: 3,
    type: "event_msg",
    payload: { type: "task_started", thread_settings: { model: "deepseek-flash" } },
  });
  assert.equal(lastThreadSettings(wrongType), null);
});

const routes = [
  { id: "deepseek-flash", name: "DeepSeek V4.1 Flash · 官方", endpoint: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { id: "d1", name: "opencodeDS", endpoint: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash" },
  { id: "d2", name: "zzsDS", endpoint: "https://zzshu.cc/v1", model: "deepseek-v4.1-flash" },
  { id: "official", name: "OpenAI · ChatGPT 登录", endpoint: "https://chatgpt.com/backend-api/codex", model: "gpt-5.6-sol" },
];

test("归属：直连官方就是订阅额度，不走助手网关", () => {
  const index = routesByModel(routes);
  assert.equal(billingFor({ model: "gpt-5.6-sol", providerID: "openai" }, index).kind, "subscription");
});

test("归属：deepseek-flash 走的是 DeepSeek 官方余额", () => {
  const index = routesByModel(routes);
  const billing = billingFor({ model: "deepseek-flash", providerID: "cma_router" }, index);
  assert.equal(billing.kind, "balance");
  assert.match(billing.label, /DeepSeek 官方余额/);
});

test("归属：重名模型带 -2 后缀也要能对上上游", () => {
  const index = routesByModel(routes);
  const billing = billingFor({ model: "deepseek-v4.1-flash-2", providerID: "cma_router" }, index);
  assert.equal(billing.kind, "quota");
  assert.match(billing.label, /opencode/);
});

test("归属：模型不在库里要如实说未知，不能编一个上游", () => {
  const index = routesByModel(routes);
  const billing = billingFor({ model: "who-knows-9", providerID: "cma_router" }, index);
  assert.equal(billing.kind, "unknown");
});

async function liveFixture(context, { minutesAgo = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-threads-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "router-v1", "codex-home");
  const day = path.join(home, "sessions", "2026", "09", "19");
  await fs.mkdir(day, { recursive: true });
  return { root, home, day };
}

test("活跃对话：读到模型、目录与标题", async (context) => {
  const { root, day } = await liveFixture(context);
  const file = path.join(day, "rollout-2026-09-19T00-00-00-01a0ffff-0000-7000-9000-000000000001.jsonl");
  const meta = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { session_id: "01a0ffff-0000-7000-9000-000000000001", cwd: "/Users/shift/Documents/ChatGPT/openclaw", model_provider: "openai" },
  });
  const userTurn = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "user_message", message: "检查一下这个额度怎么算" },
  });
  await fs.writeFile(file, [meta, userTurn, settingsEvent("deepseek-flash", "cma_router", "/Users/shift/Documents/ChatGPT/openclaw")].join("\n") + "\n");

  const threads = await listLiveThreads(root, { withinMinutes: 30, homeDirectory: path.join(root, "nohome") });
  assert.equal(threads.length, 1, "只回报还在动的对话");
  assert.equal(threads[0].model, "deepseek-flash");
  assert.equal(threads[0].providerID, "cma_router");
  assert.equal(threads[0].cwd, "/Users/shift/Documents/ChatGPT/openclaw");
  assert.match(threads[0].title, /额度/);
  assert.equal(billingFor(threads[0], routesByModel(routes)).kind, "balance");
});

test("活跃对话：太久没动的对话不回报", async (context) => {
  const { root, day } = await liveFixture(context);
  const file = path.join(day, "rollout-2026-09-19T00-00-00-01a0ffff-0000-7000-9000-000000000002.jsonl");
  await fs.writeFile(file, settingsEvent("deepseek-flash", "cma_router", "/tmp/x") + "\n");
  const stale = new Date(Date.now() - 5 * 3600_000);
  await fs.utimes(file, stale, stale);
  const threads = await listLiveThreads(root, { withinMinutes: 30, homeDirectory: path.join(root, "nohome") });
  assert.equal(threads.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  billingFor,
  lastThreadSettings,
  lastTurnContext,
  listLiveThreads,
  liveThreadRows,
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

test("新版 Codex：没有 thread_settings 时读取正式 turn_context 的模型", () => {
  const real = JSON.stringify({
    timestamp: new Date().toISOString(),
    ordinal: 5,
    type: "turn_context",
    payload: { model: "ark-code-latest", cwd: "/tmp/ni-ha", collaboration_mode: { settings: { reasoning_effort: "medium" } } },
  });
  assert.deepEqual(lastTurnContext(real), { model: "ark-code-latest", cwd: "/tmp/ni-ha" });

  const fake = JSON.stringify({ type: "response_item", payload: { text: real } });
  assert.equal(lastTurnContext(fake), null, "正文或工具输出里嵌套的 turn_context 不能算正式事件");
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

test("归属：重名模型的 -2 slug 必须精确对应第二个 route，不能算到第一个供应商", () => {
  const index = routesByModel(routes);
  const first = billingFor({ model: "deepseek-v4.1-flash", providerID: "cma_router" }, index);
  const second = billingFor({ model: "deepseek-v4.1-flash-2", providerID: "cma_router" }, index);
  assert.equal(first.kind, "quota");
  assert.match(first.label, /opencode/);
  assert.equal(second.kind, "third");
  assert.match(second.label, /zzshu/);
});

test("归属：单模型窗口按 cma_<route-id> provider 精确反查，不受重名 model 影响", () => {
  const index = routesByModel(routes);
  const billing = billingFor({ model: "deepseek-v4.1-flash", providerID: "cma_d2" }, index);
  assert.equal(billing.kind, "third");
  assert.match(billing.label, /zzshu/);
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

test("活跃对话：新版 rollout 只有 turn_context 时也能恢复真实模型", async (context) => {
  const { root, day } = await liveFixture(context);
  const sessionId = "01a0ffff-0000-7000-9000-000000000088";
  const file = path.join(day, `rollout-2026-09-19T00-00-00-${sessionId}.jsonl`);
  const meta = JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/ni-ha", model_provider: "cma_router" } });
  const turn = JSON.stringify({ timestamp: new Date().toISOString(), type: "turn_context", payload: { model: "deepseek-flash", cwd: "/tmp/ni-ha" } });
  await fs.writeFile(file, `${meta}\n${turn}\n`);

  const rows = await liveThreadRows(root, routes, { withinMinutes: 30, homeDirectory: path.join(root, "nohome") });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "deepseek-flash");
  assert.equal(rows[0].providerID, "cma_router");
  assert.equal(rows[0].billing.kind, "balance");
});

test("活跃对话：thread_settings 缺模型时，只用同 sessionId 的 route-log 精确补齐", async (context) => {
  const { root, day } = await liveFixture(context);
  const sessionId = "01a0ffff-0000-7000-9000-000000000099";
  const file = path.join(day, `rollout-2026-09-19T00-00-00-${sessionId}.jsonl`);
  const meta = JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/route-hint", model_provider: "cma_router" } });
  const userTurn = JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "user_message", message: "没有 thread_settings 也要精确追踪" } });
  await fs.writeFile(file, `${meta}\n${userTurn}\n`);
  await fs.writeFile(path.join(root, "route-log.json"), JSON.stringify([
    { at: new Date().toISOString(), route: "d1", name: "opencodeDS", host: "opencode.ai", model: "deepseek-v4.1-flash", fallback: false, kind: "request", sessionId },
  ]));

  const rows = await liveThreadRows(root, routes, { withinMinutes: 30, homeDirectory: path.join(root, "nohome") });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sessionId);
  assert.equal(rows[0].model, "deepseek-v4.1-flash");
  assert.equal(rows[0].routeID, "d1");
  assert.equal(rows[0].routeName, "opencodeDS");
  assert.equal(rows[0].billing.kind, "quota");
  assert.equal(rows[0].scopeKey, "router");
  assert.equal(path.normalize(rows[0].homePath), path.join(root, "router-v1", "codex-home"));
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

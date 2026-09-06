import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ModelStore } from "../src/model-store.mjs";
import { ExpertService, redactBrief, requestExpert } from "../src/expert-service.mjs";
import { ExpertLedger } from "../src/expert-ledger.mjs";
import { readExpertPolicy, saveExpertPolicy } from "../src/expert-policy.mjs";
import { attachExpertConfig } from "../src/local-expert-config.mjs";
import { startExpertMCP } from "../src/expert-mcp.mjs";

const brief = { reason: "blocked_after_attempts", question: "Explain how to fix a stale optimistic lock in a concurrent update.", context: "A write uses revision 2 and the database has revision 3.", attempts: ["Reloaded the entity once; version still stale", "Retried transaction without refresh; test failed"], evidence: "Test expected one successful update; both returned a conflict." };

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-expert-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  await store.read();
  await store.writeSecret("deepseek", "fake-expert-key-private");
  let requests = 0;
  const service = new ExpertService(store, { request: async (_route, _key, prompt, maxTokens) => { requests++; assert.ok(prompt.length <= 12000); assert.equal(maxTokens, 1500); return { answer: "Use compare-and-swap. Verify with two concurrent writers.", usage: { input_tokens: 100, output_tokens: 30 } }; }, ...options });
  return { store, service, requests: () => requests };
}

test("local caller consults once, identical question reuses cached result without charging", async (context) => {
  const { service, requests } = await fixture(context);
  const first = await service.consult("s5090-ornith", brief);
  const second = await service.consult("s5090-ornith", brief);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.id, first.id);
  assert.equal(requests(), 1);
  assert.equal((await service.status()).usage.calls, 1);
  assert.equal((await service.status()).usage.outputTokens, 30);
});

test("global and per-caller quotas persist across service restarts", async (context) => {
  let now = Date.now();
  const { service, store, requests } = await fixture(context, { clock: () => now });
  await saveExpertPolicy(store, { ...(await readExpertPolicy(store)), callerDailyCalls: 1, dailyCalls: 2 });
  await service.consult("s5090-ornith", brief);
  now += 100000;
  await assert.rejects(service.consult("s5090-ornith", { ...brief, question: brief.question + " Again." }), /本地主力今日专家额度/);
  await service.consult("s5090-qwen", brief);
  const reloaded = new ExpertService(store, { clock: () => now });
  await assert.rejects(reloaded.consult("s5090-qwen", { ...brief, question: brief.question + " Another issue." }), /总额度/);
  assert.equal(requests(), 2);
});

test("parallel clients reserve transactionally and cannot duplicate paid requests", async (context) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let requests = 0;
  const { store, service } = await fixture(context, { request: async () => { requests++; started(); await pending; return { answer: "Advice", usage: {} }; } });
  const first = service.consult("s5090-ornith", brief);
  await entered;
  const another = new ExpertService(store);
  await assert.rejects(another.consult("s5090-ornith", brief), /不会重复发送/);
  assert.equal(requests, 1);
  finish();
  await first;
});

test("failed calls reserve quota and are not automatically retried", async (context) => {
  let requests = 0;
  const { service } = await fixture(context, { request: async () => { requests++; throw new Error("timed out"); } });
  await assert.rejects(service.consult("s5090-qwen", brief), /timed out/);
  await assert.rejects(service.consult("s5090-qwen", brief), /冷却期/);
  const state = await service.status();
  assert.equal(state.usage.calls, 1);
  assert.equal(state.usage.records[0].status, "failed");
  assert.equal(requests, 1);
});

test("disabled policy and manual-only mode cannot be bypassed via MCP arguments", async (context) => {
  const { service, store, requests } = await fixture(context);
  await saveExpertPolicy(store, { ...(await readExpertPolicy(store)), mode: "manual_only" });
  await assert.rejects(service.consult("s5090-ornith", { ...brief, reason: "user_requested" }), /手动/);
  await service.consult("s5090-ornith", brief, { manual: true });
  await store.writeSecret("deepseek", "");
  await saveExpertPolicy(store, { ...(await readExpertPolicy(store)), mode: "disabled" });
  await assert.rejects(service.consult("s5090-ornith", brief, { manual: true }), /停用/);
  assert.equal(requests(), 1);
});

test("low-evidence, oversized, foreign-caller and route-override requests never charge", async (context) => {
  const { service, requests } = await fixture(context);
  await assert.rejects(service.consult("official", brief), /本地主力/);
  await assert.rejects(service.consult("s5090-qwen", { ...brief, attempts: ["Just guessed"] }), /至少两次/);
  await assert.rejects(service.consult("s5090-qwen", { ...brief, context: "x".repeat(13000) }), /咨询过长/);
  await assert.rejects(service.consult("s5090-qwen", { ...brief, route: "expensive" }), /不允许指定/);
  assert.equal(requests(), 0);
  assert.equal((await service.status()).usage.calls, 0);
});

test("known secrets are redacted and question text is absent from public audit", async (context) => {
  const { store } = await fixture(context);
  const service = new ExpertService(store, { request: async (_route, _key, prompt) => {
    assert.ok(!prompt.includes("fake-expert-key-private"));
    return { answer: "Avoid sharing fake-expert-key-private", usage: {} };
  } });
  const result = await service.consult("s5090-ornith", { ...brief, context: "Example token: fake-expert-key-private" });
  assert.ok(!result.answer.includes("fake-expert-key-private"));
  assert.ok(!JSON.stringify((await service.status()).usage).includes(brief.question));
  assert.ok(redactBrief("API_KEY=abcdsecret123 Authorization: Bearer abcdef123").includes("[REDACTED]"));
});

test("daily quotas reset at UTC day boundary but not on service restart", async (context) => {
  let now = Date.UTC(2026, 8, 5, 23, 59, 59);
  const { service, store } = await fixture(context, { clock: () => now });
  await saveExpertPolicy(store, { ...(await readExpertPolicy(store)), callerDailyCalls: 1, dailyCalls: 1, cooldownSeconds: 0 });
  await service.consult("s5090-qwen", brief);
  now += 2000;
  await service.consult("s5090-qwen", { ...brief, question: brief.question + " New day." });
  assert.equal((await service.status()).usage.calls, 1);
});

test("only local instances receive an idempotent MCP tool configuration", () => {
  const config = 'model = "local"\n';
  const attached = attachExpertConfig(config, "s5090-ornith");
  assert.match(attached, /mcp_servers.paid_expert/);
  assert.match(attached, /expert-mcp.mjs/);
  assert.match(attached, /\[mcp_servers.paid_expert.tools.consult_expert\]\napproval_mode = "approve"/);
  assert.ok(!attached.includes("sandbox_mode"));
  assert.equal(attachExpertConfig(attached, "s5090-ornith"), attached);
  assert.ok(!attachExpertConfig(attached, "deepseek-flash").includes("paid_expert"));
});

test("DeepSeek expert requests disable default thinking without increasing the output budget", async (context) => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ text: "Bounded advice" }] }], usage: { input_tokens: 100, output_tokens: 30 } }), { status: 200 });
  });
  const result = await requestExpert({ endpoint: "https://api.deepseek.com/v1", protocol: "responses", model: "deepseek-v4-flash" }, "fake-key", "Small question", 1500);
  assert.equal(result.answer, "Bounded advice");
  assert.deepEqual(requests[0].reasoning, { effort: "none" });
  assert.equal(requests[0].max_output_tokens, 1500);
  assert.equal(requests[0].tools, undefined);
});

test("failed expert responses preserve known billed token usage", async (context) => {
  const { service } = await fixture(context, { request: async () => { const error = new Error("No answer"); error.usage = { input_tokens: 50, output_tokens: 1500 }; throw error; } });
  await assert.rejects(service.consult("s5090-qwen", brief), /No answer/);
  const usage = (await service.status()).usage;
  assert.equal(usage.outputTokens, 1500);
  assert.equal(usage.records[0].status, "failed");
});

test("MCP initialize, tool enumeration and consultation roundtrip use valid JSON-RPC", async (context) => {
  const { service } = await fixture(context);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on("data", (chunk) => lines.push(...chunk.toString().trim().split("\n").map(JSON.parse)));
  startExpertMCP("s5090-ornith", service, input, output);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "consult_expert", arguments: brief } }) + "\n");
  for (let attempt = 0; attempt < 100 && lines.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lines.find((line) => line.id === 1).result.serverInfo.name, "codex-paid-expert");
  assert.equal(lines.find((line) => line.id === 2).result.tools.length, 2);
  assert.equal(lines.find((line) => line.id === 3).result.isError, false);
  input.end();
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore, validateRoute, atomicJSON } from "../src/model-store.mjs";
import { ProductService, renderProductConfig } from "../src/product-service.mjs";
import { toChat, toAnthropic, fromCompletion, responseEvents, nativePayload } from "../src/protocol-adapter.mjs";
import { createGateway, upstream } from "../src/model-gateway.mjs";
import { staleDays } from "../src/disk-cleanup.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 造一个够真实的窗口任务库：disk-cleanup 要按 id/rollout_path/updated_at/archived/title 判断副本。
async function seedThreads(home, entries) {
  const db = path.join(home, "state_5.sqlite");
  await fs.mkdir(path.dirname(db), { recursive: true });
  await execFileAsync("/usr/bin/sqlite3", [db, [
    "create table if not exists threads (id text primary key, rollout_path text, created_at integer, updated_at integer, source text, model_provider text, cwd text, title text, sandbox_policy text, approval_mode text, archived integer not null default 0, model text, reasoning_effort text);",
    "create table if not exists thread_attachments (thread_id text);",
    "create table if not exists thread_dynamic_tools (thread_id text);",
  ].join("\n")]);
  for (const entry of entries) {
    const file = path.join(home, "sessions", `${entry.id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x".repeat(entry.bytes ?? 64));
    await execFileAsync("/usr/bin/sqlite3", [db, `insert or replace into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, model) values ('${entry.id}', '${file}', ${entry.updatedAt}, ${entry.updatedAt}, 'cli', 'cma_router', '/tmp', '会话 ${entry.id}', 'danger-full-access', 'never', ${entry.archived ?? 0}, 'deepseek-flash');`]);
  }
  return db;
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-product-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

test("seeds mainstream providers without pretending keys exist", async (context) => {
  const store = await fixture(context);
  const data = await store.publicData();
  assert.equal(data.routes.length, 18);
  assert.equal(data.templates.length, 14);
  assert.ok(data.routes.every((route) => !route.hasKey));
  assert.equal(data.routes.find((route) => route.id === "deepseek-flash").endpoint, "https://api.deepseek.com/v1");
  assert.ok(data.routes.filter((route) => route.id.startsWith("s5090-")).every((route) => route.protocol === "chat"));
});

test("local chat bridge preserves expert namespace, call and result history", () => {
  const tool = { type: "namespace", name: "mcp__paid_expert", tools: [{ type: "function", name: "consult_expert", parameters: { type: "object", properties: {} } }] };
  const converted = toChat({ model: "local", tools: [tool], input: [{ type: "function_call", namespace: "mcp__paid_expert", name: "consult_expert", call_id: "expert1", arguments: "{}" }, { type: "function_call_output", call_id: "expert1", output: "Advice" }] });
  assert.equal(converted.body.tools[0].function.name, "mcp__paid_expert__consult_expert");
  assert.equal(converted.body.messages[0].tool_calls[0].function.name, "mcp__paid_expert__consult_expert");
  assert.equal(converted.body.messages[1].tool_call_id, "expert1");
  const result = fromCompletion({ choices: [{ message: { tool_calls: converted.body.messages[0].tool_calls } }] }, converted.definitions, "chat", "local");
  assert.equal(result.output[0].namespace, "mcp__paid_expert");
  assert.equal(result.output[0].name, "consult_expert");
});

test("preparing legacy local route migrates only its broken protocol with a backup", async (context) => {
  const store = await fixture(context);
  let data = await store.read();
  const route = data.routes.find((entry) => entry.id === "s5090-ornith");
  await store.save({ ...route, protocol: "responses" }, data.revision);
  const service = new ProductService(store);
  service.check = async () => ({ ok: true });
  service.gatewayReady = async () => {};
  const prepared = await service.prepare(route.id);
  assert.equal(prepared.route.protocol, "chat");
  const metadata = JSON.parse(await fs.readFile(path.join(prepared.homePath, "model-catalog.json"), "utf8"));
  assert.match(metadata.models[0].base_instructions, /Continue executing/);
  const config = await fs.readFile(path.join(prepared.homePath, "config.toml"), "utf8");
  assert.match(config, /mcp_servers.paid_expert.tools.consult_expert/);
  assert.match(config, /approval_mode = "approve"/);
  data = await store.read();
  assert.equal(data.routes.find((entry) => entry.id === "deepseek-flash").protocol, "responses");
  assert.equal((await fs.readdir(path.join(store.root, "backups"))).length, 2);
  await service.prepare(route.id);
  assert.equal((await store.read()).revision, data.revision);
});

test("local runtime status reports preferred worker and optional live state", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer((request, response) => {
    assert.equal(request.url, "/api/ps");
    response.end(JSON.stringify({ models: [{ name: "actual-remote-model" }] }));
  }), context);
  const data = await store.read();
  await store.mutate(data.revision, (library) => {
    for (const route of library.routes.filter((route) => route.id.startsWith("s5090-"))) route.endpoint = `${target}/v1`;
    return library;
  });
  const status = await new ProductService(store).localRuntimeStatus();
  assert.equal(status.preferredLocal, "s5090-ornith");
  assert.deepEqual(status.localCallers, ["s5090-ornith", "s5090-qwen"]);
  assert.ok(Array.isArray(status.runningInstances));
  assert.deepEqual(status.loadedModels, ["actual-remote-model"]);
  assert.match(status.message, /Ollama|当前/);
});

test("unreachable runtime is unknown rather than falsely unloaded", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer((_request, response) => { response.writeHead(503); response.end(); }), context);
  const data = await store.read();
  await store.mutate(data.revision, (library) => {
    for (const route of library.routes.filter((route) => route.id.startsWith("s5090-"))) route.endpoint = `${target}/v1`;
    return library;
  });
  assert.match((await new ProductService(store).localRuntimeStatus()).message, /状态未知/);
});

test("key changes stay private, empty keeps key, clearing removes it", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  const route = data.routes.find((entry) => entry.id === "deepseek-flash");
  await store.save(route, data.revision, "test-private-value");
  assert.equal(await store.secret("deepseek"), "test-private-value");
  await store.save({ ...route, name: "Updated" }, 2, "");
  assert.equal(await store.secret("deepseek"), "test-private-value");
  assert.equal((await fs.stat(path.join(store.root, "credentials/deepseek"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await store.publicData()).includes("test-private-value"));
  for (const file of await fs.readdir(path.join(store.root, "backups"))) assert.ok(!(await fs.readFile(path.join(store.root, "backups", file), "utf8")).includes("test-private-value"));
  await store.save(route, 3, "", true);
  assert.equal(await store.secret("deepseek"), "");
});

test("editing or adding a different endpoint never reuses original credentials", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes.find((entry) => entry.id === "deepseek-flash");
  await store.save(route, 1, "original-private-value");
  await store.save({ ...route, endpoint: "https://example.org/v1" }, 2);
  assert.notEqual((await store.route(route.id)).credentialID, "deepseek");
  assert.equal(await store.secret((await store.route(route.id)).credentialID), "");
  await store.save({ ...route, id: "new-route", endpoint: "https://example.net/v1" }, 3);
  assert.notEqual((await store.route("new-route")).credentialID, "deepseek");
});

test("concurrent stale edits are rejected without losing data", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save({ ...route, name: "First writer" }, 1);
  await assert.rejects(store.save({ ...route, name: "Lost update" }, 1), /另一窗口更新/);
  assert.equal((await store.route(route.id)).name, "First writer");
});

test("archive is reversible and official recovery is protected", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save({ ...route, archived: true }, 1);
  assert.equal((await store.route(route.id)).archived, true);
  await store.save({ ...route, archived: false }, 2);
  assert.equal((await store.route(route.id)).archived, false);
  assert.equal(validateRoute({ ...(await store.route("official")), archived: true }).archived, false);
  assert.throws(() => validateRoute({ ...(JSON.parse(JSON.stringify(route))), id: "official", protocol: "oauth", model: "agnes-2.5-flash" }), /仅允许官方模型/);
});

test("imports cannot overwrite routes or bind existing credentials", async (context) => {
  const store = await fixture(context);
  const before = await store.read();
  const service = new ProductService(store);
  await service.importLibrary(before, 1);
  const after = await store.read();
  assert.equal(after.routes.length, before.routes.length * 2 - 1);
  assert.ok(after.routes.slice(before.routes.length).every((route) => route.id === route.credentialID));
});

test("rejects traversal, URL credentials, nonlocal cleartext and malformed fields", () => {
  const base = { id: "test", name: "Test", endpoint: "https://api.example.com/v1", protocol: "chat", model: "demo" };
  for (const invalid of [{ id: "../escape" }, { endpoint: "http://api.example.com/v1" }, { endpoint: "https://user:secret@example.com" }, { endpoint: "https://api.example.com?key=secret" }, { contextWindow: 0 }, { model: "model\nattack" }]) assert.throws(() => validateRoute({ ...base, ...invalid }));
  assert.equal(validateRoute({ ...base, endpoint: "http://192.168.1.20:11434/v1" }).endpoint, "http://192.168.1.20:11434/v1");
});

test("dynamic config is idempotent, isolates provider, preserves project settings", () => {
  const route = validateRoute({ id: "test", name: "Test", endpoint: "https://example.com/v1", protocol: "chat", model: "test-model" });
  const source = 'model = "old"\nservice_tier = "priority"\n[projects."/workspace"]\ntrust_level = "trusted"\n';
  const rendered = renderProductConfig(source, route, "/tmp/catalog.json");
  assert.match(rendered, /model_provider = "cma_test"/);
  assert.match(rendered, /trust_level = "trusted"/);
  assert.ok(!rendered.includes("priority"));
  assert.equal(renderProductConfig(rendered, route, "/tmp/catalog.json"), rendered);
  assert.ok(!renderProductConfig(rendered, { ...route, id: "official", protocol: "oauth" }, "").includes("CMA_ROUTE_TOKEN"));
});

test("Chat bridge preserves function calls, namespaces, custom patch input and outputs", () => {
  const payload = { model: "test", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }, { type: "custom", name: "apply_patch" }], input: [{ type: "function_call", namespace: "functions", name: "exec", call_id: "call-1", arguments: '{"cmd":"pwd"}' }, { type: "function_call_output", call_id: "call-1", output: "/workspace" }, { type: "custom_tool_call", name: "apply_patch", call_id: "call-2", input: "*** patch" }, { type: "custom_tool_call_output", call_id: "call-2", output: "Done" }] };
  const result = toChat(payload);
  assert.equal(result.body.messages[0].tool_calls[0].function.name, "functions__exec");
  assert.equal(result.body.messages[1].tool_call_id, "call-1");
  assert.equal(JSON.parse(result.body.messages[2].tool_calls[0].function.arguments).input, "*** patch");
  const response = fromCompletion({ choices: [{ message: { tool_calls: [{ id: "new", function: { name: "apply_patch", arguments: '{"input":"*** patch"}' } }] } }] }, result.definitions, "chat", "test");
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].input, "*** patch");
  const events = responseEvents(response);
  assert.match(events, /response.custom_tool_call_input.delta/);
  assert.match(events, /response.completed/);
  assert.equal(nativePayload(payload, "pinned").input.length, 4);
});

test("Anthropic bridge preserves tool use and results with system messages", () => {
  const body = toAnthropic({ model: "test", messages: [{ role: "system", content: "You are helpful" }, { role: "assistant", tool_calls: [{ id: "call", function: { name: "exec", arguments: '{"command":"pwd"}' } }] }, { role: "tool", tool_call_id: "call", content: "/tmp" }] });
  assert.equal(body.system, "You are helpful");
  assert.equal(body.messages[0].content[0].type, "tool_use");
  assert.equal(body.messages[1].content[0].type, "tool_result");
  const response = fromCompletion({ content: [{ type: "text", text: "Done" }], usage: { input_tokens: 3, output_tokens: 2 } }, [], "anthropic", "test");
  assert.equal(response.usage.total_tokens, 5);
  assert.equal(response.output[0].content[0].text, "Done");
});

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("gateway enforces route token and pinned model, bridges real HTTP SSE", async (context) => {
  const store = await fixture(context);
  let requests = 0;
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, "Bearer upstream-secret");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).model, "test-model");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  }), context);
  await store.read();
  await store.save({ id: "test-route", name: "Test", endpoint: upstreamURL, protocol: "chat", model: "test-model" }, 1, "upstream-secret");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/test-route/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("test-route")}` };
  assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "wrong" }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://example.org" }, body: "{}" })).status, 403);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "test-model", input: "hello", stream: true }) });
  const text = await response.text();
  assert.match(text, /MODEL_ASSISTANT_OK/);
  assert.match(text, /response.output_text.delta/);
  assert.ok(!text.includes("upstream-secret"));
  assert.equal(requests, 1);
});

test("gateway queues local requests and sends heartbeat before completion", async (context) => {
  const store = await fixture(context);
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const target = await listen(http.createServer(async (_request, response) => {
    await blocker;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "local-a", name: "Local A", endpoint: target, protocol: "chat", model: "same-local", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/local-a/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("local-a")}` };
  const first = fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "same-local", input: "first" }) });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "same-local", input: "second", stream: true }) });
  assert.equal(second.status, 200);
  const reader = second.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /: waiting/);
  release();
  assert.equal((await first).status, 200);
  let events = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    events += new TextDecoder().decode(chunk.value);
  }
  assert.match(events, /response.completed/);
});

test("verification record invalidates when key changes", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save(route, 1, "old-key");
  await atomicJSON(path.join(store.root, "checks", `${route.id}.json`), { ok: true, testedAt: "2026-09-05", model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) });
  assert.equal((await store.publicData()).routes[1].verifiedAt, "2026-09-05");
  await store.save(route, 2, "new-key");
  assert.equal((await store.publicData()).routes[1].verifiedAt, null);
});

test("upstream times out, rejects redirect, and redacts vendor error bodies", async (context) => {
  const target = await listen(http.createServer((request, response) => {
    if (request.url === "/slow") return;
    if (request.url === "/redirect") { response.writeHead(302, { location: "https://example.com" }); response.end(); return; }
    response.writeHead(401); response.end("secret-in-vendor-error");
  }), context);
  const route = validateRoute({ id: "timeout", name: "Timeout", endpoint: target, protocol: "chat", model: "test" });
  await assert.rejects(upstream(route, "private", "slow", null, 20), { name: "TimeoutError" });
  await assert.rejects(upstream(route, "private", "redirect", null, 1000));
  await assert.rejects(upstream(route, "private", "denied", null, 1000), (error) => error.status === 401 && !error.message.includes("secret-in-vendor-error"));
});

test("Anthropic gateway authenticates only with provider key and returns tool calls", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer(async (request, response) => {
    assert.equal(request.headers["x-api-key"], "anthropic-private");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.url, "/v1/messages");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).tools[0].name, "exec");
    response.end(JSON.stringify({ content: [{ type: "tool_use", id: "tool-1", name: "exec", input: { command: "pwd" } }], usage: { input_tokens: 2, output_tokens: 1 } }));
  }), context);
  await store.read();
  await store.save({ id: "claude-test", name: "Claude", endpoint: `${target}/v1`, protocol: "anthropic", model: "test" }, 1, "anthropic-private");
  const gateway = await listen(createGateway(store), context);
  const result = await fetch(`${gateway}/routes/claude-test/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await store.token("claude-test")}` }, body: JSON.stringify({ model: "test", input: "pwd", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }) });
  const data = await result.json();
  assert.equal(data.output[0].name, "exec");
  assert.equal(data.output[0].call_id, "tool-1");
  assert.equal(data.output[0].arguments, '{"command":"pwd"}');
});

test("native Responses proxy preserves tool history and rejects cross-route token", async (context) => {
  const store = await fixture(context);
  let seen = 0;
  const target = await listen(http.createServer(async (request, response) => {
    seen++;
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.input[0].type, "function_call");
    assert.equal(data.input[1].type, "function_call_output");
    response.setHeader("content-type", "text/event-stream");
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  }), context);
  await store.read();
  await store.save({ id: "native", name: "Native", endpoint: target, protocol: "responses", model: "test", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/native/v1/responses`;
  const payload = JSON.stringify({ model: "test", stream: true, input: [{ type: "function_call", name: "exec", arguments: "{}", call_id: "one" }, { type: "function_call_output", call_id: "one", output: "done" }] });
  assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${await store.token("another")}` }, body: payload })).status, 401);
  const result = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${await store.token("native")}` }, body: payload });
  assert.match(await result.text(), /response.completed/);
  assert.equal(seen, 1);
});

// 副本堆得最多的是模型窗口（continuations-v1 / instances-v2），所以启动前也必须清一次。
test("启动模型窗口前清掉不重要副本，首次「导入原会话并继续」那一次不清理", async (context) => {
  const store = await fixture(context);
  const officialHome = path.join(store.root, "official-codex");
  const now = Math.floor(Date.now() / 1000);
  const ancient = now - (staleDays + 5) * 86400;

  // 官方库是权威：一条已归档、一条超 30 天、一条 30 天内的，三条都要留着。
  await seedThreads(officialHome, [
    { id: "arch-1", updatedAt: now, archived: 1 },
    { id: "old-1", updatedAt: ancient },
    { id: "fresh-1", updatedAt: now },
  ]);

  const routeID = "deepseek-flash";
  const windowRoot = path.join(store.root, "continuations-v1", routeID);
  const winHome = path.join(windowRoot, "codex-home");
  // conversation-import.json 一在，这个窗口就被当成「续接窗口」，启动走的正是 prepare() 这条路径。
  await fs.mkdir(winHome, { recursive: true });
  await fs.writeFile(path.join(winHome, "conversation-import.json"), JSON.stringify({ source: officialHome, routeID, model: "deepseek-flash" }));
  await seedThreads(winHome, [
    { id: "arch-1", updatedAt: now, bytes: 2048 },
    { id: "old-1", updatedAt: ancient, bytes: 4096 },
    { id: "fresh-1", updatedAt: now, bytes: 512 },
    { id: "own-1", updatedAt: now, bytes: 1024 },
  ]);

  const service = new ProductService(store);
  service.officialHome = officialHome;
  service.check = async () => ({ ok: true });
  service.gatewayReady = async () => {};

  const prepared = await service.prepare(routeID);
  assert.equal(prepared.diskCleanup.deletedThreads, 2, "已归档 + 超 30 天各一条");
  assert.equal(prepared.diskCleanup.deletedCacheDirs, 0);
  assert.ok(prepared.diskCleanup.freedBytes > 0);
  await assert.rejects(() => fs.access(path.join(winHome, "sessions", "arch-1.jsonl")), /ENOENT/);
  await assert.rejects(() => fs.access(path.join(winHome, "sessions", "old-1.jsonl")), /ENOENT/);
  await fs.access(path.join(winHome, "sessions", "fresh-1.jsonl"));
  await fs.access(path.join(winHome, "sessions", "own-1.jsonl"));
  // 官方库只读：三条原件一条都不能少。
  for (const id of ["arch-1", "old-1", "fresh-1"]) await fs.access(path.join(officialHome, "sessions", `${id}.jsonl`));

  // 幂等：再启动一次没有可清的。
  const again = await service.prepare(routeID);
  assert.equal(again.diskCleanup.deletedThreads, 0);
  assert.equal(again.diskCleanup.freedBytes, 0);

  // 第一次「导入原会话并继续」：刚导入的会话不能被立刻当成旧副本删掉。
  await fs.rm(windowRoot, { recursive: true, force: true });
  const fresh = await service.prepare(routeID, { continueExisting: true });
  assert.match(fresh.diskCleanup.skipped, /先不清理/);
  for (const id of ["arch-1", "old-1", "fresh-1"]) {
    await fs.access(path.join(winHome, "sessions", `${id}.jsonl`));
  }
});

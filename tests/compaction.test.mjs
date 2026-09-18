import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";
import {
  buildCompactedInput,
  estimateTokens,
  fallbackSummary,
  safeSplitIndex,
  summaryRequest,
  transcriptOf,
} from "../src/context-compaction.mjs";

const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "input_text", text }] });

// 造一段「用户提问 + 工具调用 + 工具返回 + 助手回答」的长会话。
function transcript(rounds, pad = 2000) {
  const items = [];
  for (let index = 0; index < rounds; index += 1) {
    items.push(user(`第 ${index} 轮：请处理这个任务 ${"x".repeat(pad)}`));
    items.push({ type: "function_call", name: "exec", call_id: `call_${index}`, arguments: "{}" });
    items.push({ type: "function_call_output", call_id: `call_${index}`, output: "y".repeat(pad) });
    items.push(assistant(`第 ${index} 轮完成`));
  }
  return items;
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("压缩切点落在用户消息上，绝不把工具调用和它的返回拆开", () => {
  const items = transcript(40);
  const split = safeSplitIndex(items, 30000);
  assert.ok(split > 0 && split < items.length);
  assert.equal(items[split].role, "user", "尾巴必须从用户提问开始");
  assert.ok(!["function_call_output", "custom_tool_call_output"].includes(items[split].type));
  // 被裁掉的部分里，每个 function_call 都必须带着自己的 output
  const head = items.slice(0, split);
  const calls = new Set(head.filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of head.filter((entry) => entry.type === "function_call_output")) {
    assert.ok(calls.has(item.call_id), "工具返回不能悬空");
  }
  // 尾巴里也不能出现「找不到调用」的返回
  const tailCalls = new Set(items.slice(split).filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of items.slice(split).filter((entry) => entry.type === "function_call_output")) {
    assert.ok(tailCalls.has(item.call_id), "尾巴里的工具返回必须有对应调用");
  }
});

test("会话太短或找不到安全切点时宁可不压缩", () => {
  assert.equal(safeSplitIndex(transcript(1), 1000), 0);
  assert.equal(safeSplitIndex([], 1000), 0);
  // 没有用户消息的历史（例如只有工具往返）不能切
  const noUser = [{ type: "function_call", name: "exec", call_id: "c1", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "y".repeat(500) }];
  assert.equal(safeSplitIndex(noUser, 100), 0);
});

test("压缩后的请求：摘要打头、最近对话原样保留", () => {
  const items = transcript(40);
  const split = safeSplitIndex(items, 30000);
  const out = buildCompactedInput({ summary: "任务目标：X；已完成：Y；待办：Z", tail: items.slice(split), droppedCount: split });
  assert.equal(out.length, items.length - split + 1);
  const head = out[0].content[0].text;
  assert.match(head, /较早对话已压缩/);
  assert.match(head, new RegExp(`前 ${split} 条记录`));
  assert.match(head, /任务目标：X/);
  assert.deepEqual(out.slice(1), items.slice(split), "保留段必须与原文完全一致");
});

test("摘要请求带上任务目标/待办等保真要求，并限制输出长度", () => {
  const request = summaryRequest(transcriptOf(transcript(3)), "some-model");
  assert.match(request.instructions, /任务目标/);
  assert.match(request.instructions, /待办/);
  assert.match(request.instructions, /文件路径/);
  assert.ok(request.max_output_tokens <= 8000);
  assert.equal(request.input[0].role, "user");
  assert.match(request.input[0].content[0].text, /用户：第 0 轮/);
});

test("兜底摘要会列出被裁掉的用户消息，不会静默丢上下文", () => {
  const items = transcript(6);
  const text = fallbackSummary(items.slice(0, 8));
  assert.match(text, /摘要模型本次不可用/);
  assert.match(text, /第 0 轮/);
});

test("token 估算把输出额度算进去，且偏保守", () => {
  assert.equal(estimateTokens({ max_output_tokens: 1000 }, 3200000), 1001000);
  assert.equal(estimateTokens({}, 320), 100);
  // 32 KB ≈ 1 万 tokens，这个量级不能低估（低估就会把请求发出去然后被供应商拒）
  assert.ok(estimateTokens({}, 32 * 1024) >= 10000);
});

test("切换模型导致超窗时，网关先压缩再继续，而不是报错", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-compact-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  const seen = [];
  const upstreamURL = await listen(http.createServer((request, response) => {
    let size = 0;
    let body = "";
    request.on("data", (chunk) => { size += chunk.length; body += chunk.toString(); });
    request.on("end", () => {
      // chat 协议会把 instructions 转成 system 消息，所以按原文找标记，不依赖协议形态。
      seen.push({ size, isSummary: /上下文压缩/.test(body) });
      response.setHeader("content-type", "application/json");
      if (seen.at(-1).isSummary) {
        response.end(JSON.stringify({ choices: [{ message: { content: "任务目标：继续做 X；待办：Y" } }], usage: {} }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: {} }));
      }
    });
  }), context);
  await store.read();
  await store.save({ id: "ctx-route", name: "小窗口", endpoint: upstreamURL, protocol: "chat", model: "ctx-route", contextWindow: 512000, credentialID: "ctx-route" }, 1, "k1");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/router/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  // 4.8 MB ≈ 150 万 tokens：确定超过 512K（阈值是 512000 * 3.2 ≈ 1.64 MB）
  const long = transcript(60, 20000);
  const sentBytes = JSON.stringify({ model: "ctx-route", input: long, stream: false }).length;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "ctx-route", input: long, stream: false, max_output_tokens: 500 }) });
  const text = await response.text();
  assert.equal(response.status, 200, `应压缩后继续，实际 ${response.status}: ${text.slice(0, 200)}`);
  assert.match(text, /MODEL_ASSISTANT_OK/);
  assert.equal(seen.length, 2, "一次摘要 + 一次正式请求");
  assert.equal(seen[0].isSummary, true, "第一次应是摘要请求");
  assert.equal(seen[1].isSummary, false);
  assert.ok(seen[1].size < sentBytes, `正式请求应比原始请求小：${seen[1].size} < ${sentBytes}`);
  assert.ok(sentBytes - seen[1].size > 1024 * 1024, `压缩应显著减小请求体：${sentBytes} → ${seen[1].size}`);
});

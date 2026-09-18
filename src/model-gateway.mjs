import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ModelStore } from "./model-store.mjs";
import { LocalQueue } from "./local-queue.mjs";
import { localAgentInstructions } from "./local-agent-instructions.mjs";
import { buildRouterTable, routerID, routerTableEntry } from "./router.mjs";
import { toChat, toAnthropic, fromCompletion, responseEvents, createResponseStream, nativePayload } from "./protocol-adapter.mjs";
import { anthropicStreamParser, chatStreamParser } from "./stream-parsers.mjs";
import { chatgptBaseURL, officialHeaders, officialPayload, officialTokens } from "./chatgpt-auth.mjs";

export const gatewayPort = 18793;
export const gatewayURL = `http://127.0.0.1:${gatewayPort}`;
// 供应商长时间一个字节都不返回时主动断开，避免窗口卡死；正文在流动时不会触发。
export const streamIdleMs = 300000;

// 网关进程可能由 launchd、助手应用或 CLI 启动；用源码指纹判断在跑的进程是不是当前代码。
export const gatewayBuild = createHash("sha256")
  .update(["model-gateway.mjs", "router.mjs", "protocol-adapter.mjs", "product-service.mjs", "model-store.mjs"]
    .map((name) => fs.readFileSync(new URL(name, import.meta.url)))
    .join("\n"))
  .digest("hex")
  .slice(0, 12);

export async function limitedJSON(stream, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error("请求或响应超过大小限制");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function limitedText(stream, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error("请求或响应超过大小限制");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 供应商错误里常带着用户必须看到的原因（额度耗尽、模型不存在、区域限制）。
// 只取标准 JSON 错误里的 message，并抹掉像密钥的东西，其余原始正文一律不落盘、不回显。
export function redactDetail(text) {
  return String(text)
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{6,}/g, "[已隐藏密钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{6,}/gi, "Bearer [已隐藏]")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[已隐藏长令牌]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function failureDetail(response) {
  try {
    const text = (await response.text()).slice(0, 8192);
    const data = JSON.parse(text);
    const message = data?.error?.message ?? data?.error?.detail ?? data?.message ?? data?.error;
    if (typeof message !== "string" || !message.trim()) return "";
    return redactDetail(message);
  } catch { return ""; }
}

export const quotaPattern = /quota|resource_exhausted|额度|余额|balance|credit|insufficient|限流|rate limit|too many requests/i;

// 让 Codex 停止无效重试并显示真实原因：4xx 判为请求级失败，额度类判为额度失败，其余保持可重试。
export function failureCode(status, detail) {
  if (quotaPattern.test(detail) || status === 429) return "insufficient_quota";
  if (status >= 400 && status < 500) return "invalid_prompt";
  return "";
}

export async function upstream(route, key, suffix, body, timeout = 3600000, signal) {
  if (!route.noKey && !key) throw new Error("请先配置 API Key");
  const headers = { "content-type": "application/json" };
  if (route.protocol === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${route.endpoint}/${suffix}`, {
    method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: "error",
  });
  if (!response.ok) {
    throw upstreamFailure(response.status, await failureDetail(response));
  }
  return response;
}

export function upstreamFailure(status, detail) {
  const messages = { 401: "API Key 无效或已过期", 403: "该密钥无访问权限", 404: "接口或模型不存在，请核对地址和模型 ID", 429: "额度不足或请求过于频繁" };
  const error = new Error(messages[status] || `供应商服务异常（HTTP ${status}）`);
  error.status = status;
  error.detail = detail;
  return error;
}

// 官方模型：用 Codex 自己的 ChatGPT 登录，直接转发到官方后端，账号、额度、模型都由官方管理。
export async function officialUpstream(route, payload, signal, timeout = 3600000) {
  const tokens = await officialTokens();
  const response = await fetch(`${chatgptBaseURL}/responses`, {
    method: "POST",
    headers: officialHeaders(tokens, payload.session_id || randomUUID()),
    body: JSON.stringify(officialPayload(payload, route.model)),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    redirect: "error",
  });
  if (!response.ok) throw upstreamFailure(response.status, await failureDetail(response));
  return response;
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function protocolChain(configured) {
  // 官方模型只有一条路；失败时按条目配置的备用模型继续，而不是换协议。
  if (configured === "chatgpt") return ["chatgpt"];
  return [configured, ...["responses", "chat", "anthropic"].filter((protocol) => protocol !== configured)];
}

// 主模型失败时按配置改用备用条目；备用条目也可以再带一层备用。
export async function failoverRoutes(store, route) {
  const data = await store.read();
  const chain = [];
  const seen = new Set([route.id]);
  let current = route;
  for (let depth = 0; depth < 3 && current?.fallback; depth++) {
    const next = data.routes.find((entry) => entry.id === current.fallback);
    if (!next || seen.has(next.id) || next.archived || next.protocol === "oauth" || !next.model) break;
    seen.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
}

export function errorMessage(error) {
  if (["TimeoutError", "AbortError"].includes(error.name)) return "模型调用超时或已取消";
  return error.detail ? `${error.message}（供应商说明：${error.detail}）` : error.message;
}

// Codex 收到 response.failed 才会停止重试并显示原因；只发裸 error 事件会被当成断流重试。
export function failureEvents(error, message) {
  const code = failureCode(error.status ?? 0, error.detail || message);
  const failed = {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    error: code ? { code, message } : { message },
  };
  return [
    { type: "response.created", response: { ...failed, status: "in_progress" } },
    { type: "response.failed", response: failed },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

async function rememberProtocol(store, route, protocol) {
  try {
    const data = await store.read();
    const current = data.routes.find((entry) => entry.id === route.id);
    if (!current || current.protocol === protocol) return;
    await store.save({ ...current, protocol }, data.revision);
  } catch { }
}

// 切换窗口接受切换令牌；被标记为"可切换"的条目窗口即使还在用旧环境变量启动，也能继续工作。
async function acceptedTokens(store, switched, routeID) {
  if (!switched) return [await store.token(routeID)];
  const data = await store.read();
  const tokens = [await store.token(routerID)];
  for (const route of data.routes.filter((entry) => entry.switchable)) tokens.push(await store.token(route.id));
  return tokens;
}

function localConcurrencyKey(route) {
  if (!route.noKey || route.protocol === "oauth") return "";
  try {
    const url = new URL(route.endpoint);
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
    return localHost ? url.origin : "";
  } catch { return ""; }
}

export function createGateway(store = new ModelStore(), options = {}) {
  const localQueue = new LocalQueue();
  let inflight = 0;
  return http.createServer(async (request, response) => {
    const abort = new AbortController();
    let release = () => {};
    let heartbeat;
    let sseStream = false;
    const idleMs = options.idleMs ?? streamIdleMs;
    let idleTimer;
    let idleAbort = null;
    // 每次尝试用独立的控制器：空闲超时只中断当前这次上游调用，不会连累备用模型的尝试。
    const armIdle = () => {
      clearTimeout(idleTimer);
      const target = idleAbort;
      if (!target) return;
      idleTimer = setTimeout(() => target.abort(new Error("供应商长时间没有返回数据，已断开")), idleMs);
    };
    const attemptSignal = () => {
      idleAbort = new AbortController();
      const current = idleAbort;
      armIdle();
      return AbortSignal.any([abort.signal, current.signal]);
    };
    const disarmIdle = () => clearTimeout(idleTimer);
    inflight += 1;
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    try {
      if (request.method === "GET" && request.url === "/health") return sendJSON(response, 200, { ok: true, service: "codex-model-assistant", version: 2, build: gatewayBuild, inflight: inflight - 1 });
      if (request.headers.origin) return sendJSON(response, 403, { error: { message: "浏览器请求不允许访问模型网关" } });
      const match = request.url?.match(/^\/(?:routes\/([a-z][a-z0-9-]{0,63})\/|router\/)v1\/(responses|models)$/);
      if (!match) return sendJSON(response, 404, { error: { message: "接口不存在" } });
      const switched = !match[1];
      const endpoint = match[2];
      const supplied = String(request.headers.authorization || "").replace(/^Bearer /, "");
      const tokens = await acceptedTokens(store, switched, match[1]);
      if (!tokens.some((token) => supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token)))) return sendJSON(response, 401, { error: { message: "实例访问令牌无效" } });
      let route = switched ? null : await store.route(match[1]);
      if (route?.archived || route?.protocol === "oauth") return sendJSON(response, 403, { error: { message: "此模型不能通过网关调用" } });
      if (endpoint === "models" && request.method === "GET" && switched) {
        const table = buildRouterTable((await store.read()).routes);
        return sendJSON(response, 200, { object: "list", data: table.map(({ slug, route: entry }) => ({ id: slug, object: "model", owned_by: entry.vendor || "codex-model-assistant" })) });
      }
      if (endpoint === "models" && request.method === "GET") {
        const result = await upstream(route, await store.secret(route.credentialID), "models", null, 15000, abort.signal);
        return sendJSON(response, 200, await limitedJSON(result.body));
      }
      if (request.method !== "POST" || endpoint !== "responses") return sendJSON(response, 405, { error: { message: "请求方法不支持" } });
      const payload = await limitedJSON(request);
      if (switched) {
        const entry = routerTableEntry(buildRouterTable((await store.read()).routes), payload.model);
        if (!entry) return sendJSON(response, 400, { error: { message: "所选模型不在可切换窗口内，请在模型助手中重新打开切换窗口" } });
        route = entry.route;
        payload.model = route.model;
      } else if (!route.model || payload.model !== route.model) {
        return sendJSON(response, 400, { error: { message: "模型与实例不匹配，请在助手中创建对应实例" } });
      }
      if (["s5090-ornith", "s5090-qwen"].includes(route.id) && !payload.instructions?.includes(localAgentInstructions)) payload.instructions = `${localAgentInstructions}\n\n${payload.instructions || ""}`;
      const key = await store.secret(route.credentialID);
      const busyKey = localConcurrencyKey(route);
      if (payload.stream && route.protocol !== "responses") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        sseStream = true;
        response.write(": waiting\n\n");
        heartbeat = setInterval(() => response.write(": waiting\n\n"), 5000);
      }
      release = await localQueue.acquire(busyKey, AbortSignal.any([abort.signal, AbortSignal.timeout(600000)]));
      if ((await store.route(route.id)).archived) throw new Error("此模型已停用");
      // 供应商只实现了一种接口时，按 404/405 自动换成能用的那种并记下来，用户不必先猜对接口格式。
      const candidates = [{ route, key }, ...(await failoverRoutes(store, route)).map((entry) => ({ route: entry, key: null }))];
      let served = false;
      let lastError = null;
      let eventsSent = false;
      for (const candidate of candidates) {
        const target = candidate.route;
        const targetKey = candidate.key ?? (await store.secret(target.credentialID));
        // 从真正发起请求就开始计时：供应商连响应头都不给的情况同样会断开并转备用。
        const callSignal = attemptSignal();
        const attempts = protocolChain(target.protocol);
        for (const [index, attempt] of attempts.entries()) {
          try {
            if (attempt === "chatgpt") {
              const result = await officialUpstream({ ...target, protocol: attempt }, { ...payload, model: target.model }, callSignal);
              if (response.headersSent) response.end(await limitedText(result.body));
              else {
                response.writeHead(200, { "content-type": result.headers.get("content-type") || "application/json", "cache-control": "no-store" });
                sseStream = true;
                armIdle();
                await pipeline(Readable.fromWeb(result.body), response);
                disarmIdle();
              }
            } else if (attempt === "responses") {
              const result = await upstream({ ...target, protocol: attempt }, targetKey, "responses", nativePayload({ ...payload, model: target.model }, target.model), 3600000, callSignal);
              if (attempt !== target.protocol) await rememberProtocol(store, target, attempt);
              if (response.headersSent) response.end(await limitedText(result.body));
              else {
                response.writeHead(200, { "content-type": result.headers.get("content-type") || "application/json", "cache-control": "no-store" });
                if ((result.headers.get("content-type") || "").includes("text/event-stream")) sseStream = true;
                armIdle();
                await pipeline(Readable.fromWeb(result.body), response).catch((error) => { throw error; });
                disarmIdle();
              }
            } else {
              if (payload.stream && !response.headersSent) {
                response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
                sseStream = true;
                response.write(": waiting\n\n");
                heartbeat = setInterval(() => response.write(": waiting\n\n"), 5000);
              }
              const { body, definitions } = toChat({ ...payload, model: target.model }, { stream: Boolean(payload.stream) });
              const path = attempt === "anthropic" ? "messages" : "chat/completions";
              const result = await upstream({ ...target, protocol: attempt }, targetKey, path, attempt === "anthropic" ? toAnthropic(body, { stream: Boolean(payload.stream) }) : body, 3600000, callSignal);
              if (attempt !== target.protocol) await rememberProtocol(store, target, attempt);
              armIdle();
              if (!payload.stream) sendJSON(response, 200, fromCompletion(await limitedJSON(result.body), definitions, attempt, target.model));
              else if (!(result.headers.get("content-type") || "").includes("text/event-stream")) {
                response.end(responseEvents(fromCompletion(await limitedJSON(result.body), definitions, attempt, target.model)));
              } else {
                const stream = createResponseStream({ model: target.model, send: (chunk) => response.write(chunk) });
                stream.created();
                eventsSent = true;
                const parse = (attempt === "anthropic" ? anthropicStreamParser : chatStreamParser)((event) => {
                  if (event.type === "text") stream.textDelta(event.text);
                  else if (event.type === "reasoning") stream.reasoningDelta(event.text);
                  else if (event.type === "tool") stream.toolDelta(event.index, event);
                  else if (event.type === "usage") stream.setUsage(event.usage);
                });
                const decoder = new TextDecoder();
                armIdle();
                for await (const chunk of Readable.fromWeb(result.body)) {
                  armIdle();
                  parse(decoder.decode(chunk, { stream: true }));
                }
                disarmIdle();
                stream.finish({ definitions });
                response.end();
              }
            }
            served = true;
            break;
          } catch (error) {
            lastError = error;
            if (abort.signal.aborted) throw error;
            // 已经发出正文增量就不能再换供应商，否则客户端会收到两段拼接内容。
            if (eventsSent) throw error;
            const wrongEndpoint = [404, 405].includes(error.status);
            if (wrongEndpoint && index < attempts.length - 1) {
              clearInterval(heartbeat);
              heartbeat = undefined;
              continue;
            }
            break;
          }
        }
        if (served) {
          break;
        }
      }
      if (!served) throw lastError || new Error("模型调用失败");
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) {
          const message = errorMessage(error);
          response.end(sseStream ? failureEvents(error, message) : `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "model_gateway_error", message } })}\n\n`);
        }
        return;
      }
      const code = failureCode(error.status ?? 0, error.detail || "");
      sendJSON(response, error.status || 502, { error: { code: code || undefined, message: errorMessage(error), type: "model_gateway_error" } });
    } finally {
      clearInterval(heartbeat);
      disarmIdle();
      release();
      inflight -= 1;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway();
  server.requestTimeout = 3650000;
  server.headersTimeout = 15000;
  server.on("error", (error) => {
    void (async () => {
      if (error?.code === "EADDRINUSE") {
        try {
          const response = await fetch(`${gatewayURL}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
          const data = await response.json();
          if (response.ok && data?.service === "codex-model-assistant" && data?.version === 2) {
            process.stdout.write("Model gateway already running on loopback\n");
            process.exit(0);
            return;
          }
        } catch { }
      }
      process.stderr.write(`${error?.stack || error}\n`);
      process.exit(1);
    })();
  });
  server.listen(gatewayPort, "127.0.0.1", () => process.stdout.write("Model gateway ready on loopback\n"));
}

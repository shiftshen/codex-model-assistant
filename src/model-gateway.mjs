import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ModelStore } from "./model-store.mjs";
import { toChat, toAnthropic, fromCompletion, responseEvents, nativePayload } from "./protocol-adapter.mjs";

export const gatewayPort = 18793;
export const gatewayURL = `http://127.0.0.1:${gatewayPort}`;
const activeLocalModels = new Set();

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
    await response.body?.cancel();
    const messages = { 401: "API Key 无效或已过期", 403: "该密钥无访问权限", 404: "接口或模型不存在，请核对地址和模型 ID", 429: "额度不足或请求过于频繁" };
    const error = new Error(messages[response.status] || `供应商服务异常（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function localConcurrencyKey(route) {
  if (!route.noKey || route.protocol === "oauth") return "";
  try {
    const url = new URL(route.endpoint);
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
    return localHost ? `${url.origin}|${route.model}` : "";
  } catch { return ""; }
}

export function createGateway(store = new ModelStore()) {
  return http.createServer(async (request, response) => {
    const abort = new AbortController();
    let busyKey = "";
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    try {
      if (request.method === "GET" && request.url === "/health") return sendJSON(response, 200, { ok: true, service: "codex-model-assistant", version: 2 });
      if (request.headers.origin) return sendJSON(response, 403, { error: { message: "浏览器请求不允许访问模型网关" } });
      const match = request.url?.match(/^\/routes\/([a-z][a-z0-9-]{0,63})\/v1\/(responses|models)$/);
      if (!match) return sendJSON(response, 404, { error: { message: "接口不存在" } });
      const route = await store.route(match[1]);
      const token = await store.token(route.id);
      const supplied = String(request.headers.authorization || "").replace(/^Bearer /, "");
      if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return sendJSON(response, 401, { error: { message: "实例访问令牌无效" } });
      if (route.archived || route.protocol === "oauth") return sendJSON(response, 403, { error: { message: "此模型不能通过网关调用" } });
      const key = await store.secret(route.credentialID);
      if (match[2] === "models" && request.method === "GET") {
        const result = await upstream(route, key, "models", null, 15000, abort.signal);
        return sendJSON(response, 200, await limitedJSON(result.body));
      }
      if (request.method !== "POST" || match[2] !== "responses") return sendJSON(response, 405, { error: { message: "请求方法不支持" } });
      const payload = await limitedJSON(request);
      if (!route.model || payload.model !== route.model) return sendJSON(response, 400, { error: { message: "模型与实例不匹配，请在助手中创建对应实例" } });
      busyKey = localConcurrencyKey(route);
      if (busyKey) {
        if (activeLocalModels.has(busyKey)) {
          response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: { message: "同一个本地模型正在处理另一个 Codex 请求；请等当前任务完成，或换 Qwen/Ornith/付费专家分流。", type: "local_model_busy" } }));
          busyKey = "";
          return;
        }
        activeLocalModels.add(busyKey);
      }
      if (route.protocol === "responses") {
        const result = await upstream(route, key, "responses", nativePayload(payload, route.model), 3600000, abort.signal);
        response.writeHead(200, { "content-type": result.headers.get("content-type") || "application/json", "cache-control": "no-store" });
        await pipeline(Readable.fromWeb(result.body), response);
      } else {
        const { body, definitions } = toChat(payload);
        const result = await upstream(route, key, route.protocol === "anthropic" ? "messages" : "chat/completions", route.protocol === "anthropic" ? toAnthropic(body) : body, 3600000, abort.signal);
        const converted = fromCompletion(await limitedJSON(result.body), definitions, route.protocol, route.model);
        if (payload.stream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          response.end(responseEvents(converted));
        } else sendJSON(response, 200, converted);
      }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const message = ["TimeoutError", "AbortError"].includes(error.name) ? "模型调用超时或已取消" : error.message;
      sendJSON(response, error.status || 502, { error: { message, type: "model_gateway_error" } });
    } finally {
      if (busyKey) activeLocalModels.delete(busyKey);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway();
  server.requestTimeout = 3650000;
  server.headersTimeout = 15000;
  server.listen(gatewayPort, "127.0.0.1", () => process.stdout.write("Model gateway ready on loopback\n"));
}

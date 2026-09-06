import { pathToFileURL } from "node:url";
import { ExpertService } from "./expert-service.mjs";

export const expertTools = [
  { name: "expert_status", description: "Free: check paid-expert policy, remaining daily call limits and recent usage. Local Ornith/Qwen should do routine coding themselves.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "consult_expert", description: "PAID, bounded consultation. Use only after at least two distinct local attempts with error evidence, a concrete architecture/high-risk review, or explicit user request. Send a minimal sanitized brief, not full history or secrets. The expert cannot execute tools. Apply and test its advice locally. Repeating identical requests uses cache. Errors and timeouts are not automatically retried. Never alter expert policy or bypass quotas.",
    inputSchema: { type: "object", properties: {
      reason: { type: "string", enum: ["blocked_after_attempts", "architecture_review", "high_risk_review", "user_requested"] },
      question: { type: "string", minLength: 12, maxLength: 3000 }, context: { type: "string", maxLength: 10000 },
      attempts: { type: "array", items: { type: "string", maxLength: 1500 }, maxItems: 5 }, evidence: { type: "string", maxLength: 3000 },
    }, required: ["reason", "question", "context", "attempts", "evidence"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

export function startExpertMCP(caller, service = new ExpertService(), input = process.stdin, output = process.stdout) {
  let buffer = "";
  const controllers = new Map();
  const send = (value) => output.write(JSON.stringify(value) + "\n");
  const handle = async (message) => {
    if (!message || typeof message !== "object" || typeof message.method !== "string") { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return; }
    if (message.method === "notifications/cancelled") { controllers.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    try {
      if (message.method === "initialize") {
        await service.status(caller);
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codex-paid-expert", version: "2.1.0" }, instructions: "Local models remain the primary workers. Consult a paid expert only for justified blockers, within the configured limits. No automatic retries." } });
      } else if (message.method === "ping") send({ jsonrpc: "2.0", id: message.id, result: {} });
      else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: expertTools } });
      else if (message.method === "tools/call") {
        const controller = new AbortController();
        controllers.set(message.id, controller);
        try {
          let result;
          if (message.params?.name === "expert_status") result = await service.status(caller);
          else if (message.params?.name === "consult_expert") result = await service.consult(caller, message.params.arguments, { signal: controller.signal });
          else throw new Error("未知专家工具");
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } });
        } catch (error) {
          send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, message: error.message, instruction: "Continue locally. Do not repeat paid requests or bypass the policy." }) }], isError: true } });
        } finally { controllers.delete(message.id); }
      } else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    } catch (error) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } }); }
  };
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 256000) { buffer = ""; send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } }); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)); }
      catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
    }
  });
  input.on("end", () => { for (const controller of controllers.values()) controller.abort(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startExpertMCP(process.argv[2]);

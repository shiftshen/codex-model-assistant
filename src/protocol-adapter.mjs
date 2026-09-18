import { randomUUID } from "node:crypto";

function toolDefinitions(tools = [], namespace = "") {
  return tools.flatMap((tool) => {
    if (tool.type === "namespace") return toolDefinitions(tool.tools, tool.name);
    if (!["function", "custom"].includes(tool.type)) return [];
    const name = namespace ? `${namespace}__${tool.name}` : tool.name;
    return [{ name, original: tool.name, namespace, custom: tool.type === "custom", description: tool.description || "", parameters: tool.type === "custom" ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } : tool.parameters || { type: "object", properties: {} } }];
  });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => part.text || "").join("\n");
}

export function toChat(payload, { stream = false } = {}) {
  const definitions = toolDefinitions(payload.tools);
  const messages = [];
  if (payload.instructions) messages.push({ role: "system", content: payload.instructions });
  const input = typeof payload.input === "string" ? [{ role: "user", content: payload.input }] : payload.input || [];
  for (const item of input) {
    if (item.type === "reasoning") continue;
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const definition = definitions.find((entry) => entry.original === item.name && entry.namespace === (item.namespace || ""));
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: definition?.name || item.name, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments } }] });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textContent(item.output) });
    } else if (item.role) {
      const content = Array.isArray(item.content) ? item.content.map((part) => {
        if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url } };
        if (["input_text", "output_text", "text"].includes(part.type)) return { type: "text", text: part.text };
        throw new Error(`不支持的输入内容：${part.type}`);
      }) : item.content;
      messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    } else {
      throw new Error(`无法转换历史项目：${item.type}`);
    }
  }
  const merged = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (message.tool_calls && previous?.tool_calls) previous.tool_calls.push(...message.tool_calls);
    else merged.push(message);
  }
  const body = { model: payload.model, messages: merged, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (definitions.length) body.tools = definitions.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
  if (payload.max_output_tokens) body.max_tokens = payload.max_output_tokens;
  if (payload.tool_choice === "none" || payload.tool_choice === "auto" || payload.tool_choice === "required") body.tool_choice = payload.tool_choice;
  return { body, definitions };
}

export function toAnthropic(chat, { stream = false } = {}) {
  const system = chat.messages.filter((message) => message.role === "system").map((message) => textContent(message.content)).join("\n\n");
  const messages = [];
  for (const message of chat.messages.filter((entry) => entry.role !== "system")) {
    let role = message.role === "assistant" ? "assistant" : "user";
    let content;
    if (message.role === "tool") content = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }];
    else if (message.tool_calls) content = message.tool_calls.map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }));
    else content = (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || []).map((part) => {
      if (part.type !== "image_url") return part;
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
      return { type: "image", source: match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url: part.image_url.url } };
    });
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  const body = { model: chat.model, max_tokens: chat.max_tokens || 8192, messages, stream };
  if (system) body.system = system;
  if (chat.tools?.length) body.tools = chat.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
  if (chat.tool_choice) body.tool_choice = { type: chat.tool_choice === "required" ? "any" : chat.tool_choice };
  return body;
}

export function fromCompletion(result, definitions, protocol, model) {
  let text, calls, usage;
  if (protocol === "anthropic") {
    if (!Array.isArray(result.content)) throw new Error("供应商返回无效的 Messages 响应");
    text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    calls = result.content.filter((part) => part.type === "tool_use").map((part) => ({ id: part.id, function: { name: part.name, arguments: JSON.stringify(part.input) } }));
    usage = result.usage;
  } else {
    if (!result.choices?.[0]?.message) throw new Error("供应商返回无效的 Chat 响应");
    text = result.choices[0].message.content || "";
    calls = result.choices[0].message.tool_calls || [];
    usage = { input_tokens: result.usage?.prompt_tokens || 0, output_tokens: result.usage?.completion_tokens || 0 };
  }
  const output = [];
  if (text) output.push({ id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const call of calls) {
    const definition = definitions.find((entry) => entry.name === call.function.name);
    const item = { id: `fc_${randomUUID()}`, type: definition?.custom ? "custom_tool_call" : "function_call", call_id: call.id, name: definition?.original || call.function.name, status: "completed" };
    if (definition?.namespace) item.namespace = definition.namespace;
    if (definition?.custom) item.input = JSON.parse(call.function.arguments).input;
    else item.arguments = call.function.arguments;
    output.push(item);
  }
  const incomplete = result.stop_reason === "max_tokens" || result.choices?.[0]?.finish_reason === "length";
  return { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: incomplete ? "incomplete" : "completed", incomplete_details: incomplete ? { reason: "max_output_tokens" } : null, output, usage: { input_tokens: usage?.input_tokens || 0, output_tokens: usage?.output_tokens || 0, total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0) } };
}

export function responseEvents(response) {
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } }];
  response.output.forEach((item, output_index) => {
    const initial = structuredClone(item);
    initial.status = "in_progress";
    if (item.type === "message") initial.content = [];
    if (item.type === "function_call") initial.arguments = "";
    if (item.type === "custom_tool_call") initial.input = "";
    events.push({ type: "response.output_item.added", output_index, item: initial });
    if (item.type === "message") {
      const part = item.content[0];
      events.push({ type: "response.content_part.added", item_id: item.id, output_index, content_index: 0, part: { ...part, text: "" } });
      events.push({ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: part.text });
      events.push({ type: "response.output_text.done", item_id: item.id, output_index, content_index: 0, text: part.text });
      events.push({ type: "response.content_part.done", item_id: item.id, output_index, content_index: 0, part });
    } else {
      const field = item.type === "custom_tool_call" ? "input" : "arguments";
      const eventType = item.type === "custom_tool_call" ? "custom_tool_call_input" : "function_call_arguments";
      events.push({ type: `response.${eventType}.delta`, item_id: item.id, output_index, delta: item[field] });
      events.push({ type: `response.${eventType}.done`, item_id: item.id, output_index, [field]: item[field] });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: `response.${response.status}`, response });
  return events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

// 流式转发：正文边收边发（Codex 只认 response.output_text.delta），
// 结束前再补上完整条目和 response.completed，函数调用参数按完整值一次性给出。
export function createResponseStream({ model, send }) {
  const responseID = `resp_${randomUUID()}`;
  const base = { id: responseID, object: "response", created_at: Math.floor(Date.now() / 1000), model };
  const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] };
  const calls = new Map();
  const order = [];
  let sequence = 1;
  let started = false;
  let textBuffer = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const emit = (type, payload) => send(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);

  function startMessage() {
    if (started) return;
    started = true;
    emit("response.output_item.added", { output_index: 0, item: { ...message, content: [] } });
    emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    order.push(message);
  }

  function callAt(index) {
    if (!calls.has(index)) {
      const call = { id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: "", arguments: "", type: "function_call", custom: false, namespace: "" };
      calls.set(index, call);
      order.push(call);
    }
    return calls.get(index);
  }

  function mapCall(call, definitions) {
    const definition = definitions.find((entry) => entry.name === call.name);
    const item = { id: call.id, call_id: call.call_id, name: definition?.original || call.name, status: "completed" };
    if (definition?.namespace) item.namespace = definition.namespace;
    if (definition?.custom) {
      item.type = "custom_tool_call";
      try { item.input = JSON.parse(call.arguments).input ?? call.arguments; }
      catch { item.input = call.arguments; }
    } else {
      item.type = "function_call";
      item.arguments = call.arguments || "{}";
    }
    return item;
  }

  return {
    created() { emit("response.created", { response: { ...base, status: "in_progress", output: [] } }); },
    textDelta(chunk) {
      if (!chunk) return;
      startMessage();
      textBuffer += chunk;
      emit("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: chunk });
    },
    reasoningDelta(chunk) {
      if (!chunk) return;
      emit("response.reasoning_text.delta", { item_id: `rs_${responseID}`, output_index: 0, content_index: 0, delta: chunk });
    },
    toolDelta(index, { id, name, arguments: args }) {
      const call = callAt(index);
      if (id) call.call_id = id;
      if (name) call.name += name;
      if (args) call.arguments += args;
    },
    setUsage(next) { usage = { ...usage, ...(next || {}) }; },
    finish({ definitions = [] } = {}) {
      const output = [];
      for (const entry of order) {
        const item = entry === message ? { ...message, content: [{ ...message.content[0], text: textBuffer }] } : mapCall(entry, definitions);
        if (item.type === "message" && !item.content[0].text) continue;
        output.push(item);
        emit("response.output_item.done", { output_index: output.length - 1, item });
      }
      const response = {
        ...base,
        status: "completed",
        incomplete_details: null,
        output,
        usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
      };
      emit("response.completed", { response });
      return response;
    },
  };
}

export function nativePayload(payload, model) {
  const result = structuredClone(payload);
  result.model = model;
  result.store = false;
  delete result.service_tier;
  delete result.prompt_cache_key;
  delete result.prompt_cache_retention;
  if (result.tools) result.tools = result.tools.filter((tool) => ["function", "custom", "namespace"].includes(tool.type));
  return result;
}

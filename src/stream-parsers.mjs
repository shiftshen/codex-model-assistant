// 把供应商的流式格式拆成统一事件，交给转换层再变成 Codex 的 Responses 事件。
function sseReader(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { onEvent({ type: "done" }); continue; }
      try { onEvent({ type: "payload", value: JSON.parse(data) }); } catch { }
    }
  };
}

// OpenAI 兼容的 Chat Completions 流：正文、思考内容、函数调用参数都是增量。
export function chatStreamParser(onEvent) {
  return sseReader((event) => {
    if (event.type !== "payload") return onEvent(event);
    const value = event.value;
    if (value.usage) {
      onEvent({
        type: "usage",
        usage: {
          input_tokens: value.usage.prompt_tokens ?? value.usage.input_tokens ?? 0,
          output_tokens: value.usage.completion_tokens ?? value.usage.output_tokens ?? 0,
        },
      });
    }
    const choice = value.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) onEvent({ type: "reasoning", text: delta.reasoning_content });
    if (typeof delta.content === "string" && delta.content) onEvent({ type: "text", text: delta.content });
    for (const call of delta.tool_calls || []) {
      onEvent({ type: "tool", index: call.index ?? 0, id: call.id, name: call.function?.name, arguments: call.function?.arguments });
    }
    if (choice.finish_reason) onEvent({ type: "finish", reason: choice.finish_reason });
  });
}

// Anthropic Messages 流：内容按 block 组织，工具入参是 partial_json 片段。
export function anthropicStreamParser(onEvent) {
  const blocks = new Map();
  return sseReader((event) => {
    if (event.type !== "payload") return onEvent(event);
    const value = event.value;
    if (value.type === "message_start") {
      if (value.message?.usage) onEvent({ type: "usage", usage: { input_tokens: value.message.usage.input_tokens || 0, output_tokens: 0 } });
      return;
    }
    if (value.type === "content_block_start") {
      const block = value.content_block || {};
      blocks.set(value.index, block);
      if (block.type === "tool_use") onEvent({ type: "tool", index: value.index, id: block.id, name: block.name, arguments: "" });
      if (block.type === "text" && block.text) onEvent({ type: "text", text: block.text });
      return;
    }
    if (value.type === "content_block_delta") {
      const delta = value.delta || {};
      if (delta.type === "text_delta" && delta.text) onEvent({ type: "text", text: delta.text });
      else if (delta.type === "thinking_delta" && delta.thinking) onEvent({ type: "reasoning", text: delta.thinking });
      else if (delta.type === "input_json_delta") onEvent({ type: "tool", index: value.index, arguments: delta.partial_json });
      return;
    }
    if (value.type === "message_delta") {
      if (value.delta?.stop_reason) onEvent({ type: "finish", reason: value.delta.stop_reason });
      if (value.usage) onEvent({ type: "usage", usage: { input_tokens: 0, output_tokens: value.usage.output_tokens || 0 } });
      return;
    }
    if (value.type === "message_stop") onEvent({ type: "done" });
  });
}

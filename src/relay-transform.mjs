export function sanitizeResponsesPayload(payload) {
  const output = structuredClone(payload);
  if (Array.isArray(output.tools)) {
    output.tools = output.tools.filter(
      (tool) => tool?.type === "function" || tool?.type === "mcp",
    );
  }
  if (Array.isArray(output.input)) {
    output.input = output.input.filter(
      (item) => item?.type !== "reasoning" && item?.type !== "function_call",
    );
  }
  if (output.tool_choice && typeof output.tool_choice === "object") {
    delete output.tool_choice.namespace;
  }
  return output;
}

import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeResponsesPayload } from "../src/relay-transform.mjs";

test("removes unsupported Codex tools and reasoning history", () => {
  const output = sanitizeResponsesPayload({
    tools: [
      { type: "function", name: "exec" },
      { type: "namespace", name: "browser" },
      { type: "custom", name: "apply_patch" },
      { type: "mcp", server_label: "docs" },
    ],
    input: [
      { type: "message", role: "user", content: [] },
      { type: "reasoning", id: "reasoning-1" },
      { type: "function_call", call_id: "call-1" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
    tool_choice: { namespace: "browser", type: "auto" },
  });

  assert.deepEqual(output.tools.map((tool) => tool.type), ["function", "mcp"]);
  assert.deepEqual(output.input.map((item) => item.type), ["message", "function_call_output"]);
  assert.equal("namespace" in output.tool_choice, false);
});

test("does not mutate the caller payload", () => {
  const input = { tools: [{ type: "custom" }] };
  sanitizeResponsesPayload(input);
  assert.deepEqual(input, { tools: [{ type: "custom" }] });
});

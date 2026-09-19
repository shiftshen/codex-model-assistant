import test from "node:test";
import assert from "node:assert/strict";

import {
  detectRoute,
  renderConfig,
  routeDefinitions,
} from "../src/route-config.mjs";

const baseConfig = `# user settings
model = "gpt-6-astra"
model_reasoning_effort = "medium"
plan_mode_reasoning_effort = "medium"
model_reasoning_summary = "auto"

[agents]
enabled = true
default_subagent_model = "gpt-5.6-terra"
default_subagent_reasoning_effort = "high"

[projects."/Users/shift/work"]
trust_level = "trusted"

[plugins."example"]
enabled = true
`;

test("switches to Agnes without changing unrelated sections", () => {
  const output = renderConfig(baseConfig, "agnes");

  assert.match(output, /^model_provider = "agnes"$/m);
  assert.match(output, /^model = "agnes-2.5-flash"$/m);
  assert.match(output, /model-catalog\.agnes\.json/);
  assert.match(output, /\[projects\."\/Users\/shift\/work"\]/);
  assert.match(output, /\[plugins\."example"\]\nenabled = true/);
  assert.match(output, /^model_reasoning_effort = "medium"$/m);
  assert.match(output, /^plan_mode_reasoning_effort = "medium"$/m);
  assert.match(output, /^model_reasoning_summary = "auto"$/m);
  assert.match(output, /\[agents\][\s\S]*default_subagent_model = "gpt-5\.6-terra"/);
  assert.match(output, /\[agents\][\s\S]*default_subagent_reasoning_effort = "high"/);
  assert.equal(detectRoute(output), "agnes");
});

test("switches back to official and removes custom top-level routing", () => {
  const custom = renderConfig(baseConfig, "s5090-qwen");
  const output = renderConfig(custom, "official");
  const topLevel = output.slice(0, output.indexOf("[projects."));

  assert.match(topLevel, /^model = "gpt-6-astra"$/m);
  assert.doesNotMatch(topLevel, /^model_provider\s*=/m);
  assert.doesNotMatch(topLevel, /^model_catalog_json\s*=/m);
  assert.equal(detectRoute(output), "official");
});

test("repeated route rendering is idempotent", () => {
  const first = renderConfig(baseConfig, "deepseek-pro");
  const second = renderConfig(first, "deepseek-pro");

  assert.equal(second, first);
  assert.equal((second.match(/BEGIN CODEX MODEL ASSISTANT PROVIDERS/g) || []).length, 1);
});

test("rejects unknown routes", () => {
  assert.throws(() => renderConfig(baseConfig, "missing"), /Unknown route/);
});

test("defines every user-facing route with a model and label", () => {
  const ids = Object.keys(routeDefinitions);

  assert.deepEqual(ids, [
    "official",
    "deepseek-flash",
    "deepseek-pro",
    "agnes",
    "s5090-qwen",
    "s5090-ornith",
  ]);
  for (const route of Object.values(routeDefinitions)) {
    assert.ok(route.label);
    assert.ok(route.model);
  }
});

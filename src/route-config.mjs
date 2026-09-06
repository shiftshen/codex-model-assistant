export const routeDefinitions = Object.freeze({
  official: {
    label: "OpenAI 官方",
    model: "gpt-6-astra",
    provider: null,
    catalog: null,
    endpoint: "ChatGPT OAuth",
    accent: "blue",
  },
  "deepseek-flash": {
    label: "DeepSeek V4 Flash",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    catalog: "/Users/shift/.codex/model-catalog.deepseek.json",
    endpoint: "http://127.0.0.1:18792/v1",
    accent: "purple",
  },
  "deepseek-pro": {
    label: "DeepSeek V4 Pro",
    model: "deepseek-v4-pro",
    provider: "deepseek-official",
    catalog: "/Users/shift/.codex/model-catalog.deepseek.json",
    endpoint: "http://127.0.0.1:18792/v1",
    accent: "purple",
  },
  agnes: {
    label: "Agnes 2.5 Flash",
    model: "agnes-2.5-flash",
    provider: "agnes",
    catalog: "/Users/shift/.codex/model-catalog.agnes.json",
    endpoint: "http://127.0.0.1:18790/v1",
    accent: "orange",
  },
  "s5090-qwen": {
    label: "Qwen3.8 27B（5090）",
    model: "qwen3.8:27b-96k",
    provider: "s5090",
    catalog: "/Users/shift/.codex/model-catalog.s5090.json",
    endpoint: "http://127.0.0.1:18791/v1",
    accent: "green",
  },
  "s5090-ornith": {
    label: "Ornith 1.5 35B（5090）",
    model: "ornith-1.5:35b-96k",
    provider: "s5090",
    catalog: "/Users/shift/.codex/model-catalog.s5090.json",
    endpoint: "http://127.0.0.1:18791/v1",
    accent: "green",
  },
});

const managedStart = "# BEGIN CODEX MODEL ASSISTANT PROVIDERS";
const managedEnd = "# END CODEX MODEL ASSISTANT PROVIDERS";

const managedProviderBlock = `${managedStart}
[model_providers.agnes]
name = "Agnes AI"
base_url = "http://127.0.0.1:18790/v1"
env_key = "AGNES_API_KEY"
wire_api = "responses"

[model_providers.deepseek-official]
name = "DeepSeek Official"
base_url = "http://127.0.0.1:18792/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"

[model_providers.s5090]
name = "S5090 Ollama (192.168.1.200)"
base_url = "http://127.0.0.1:18791/v1"
wire_api = "responses"
${managedEnd}`;

function removeManagedProviderBlock(config) {
  const pattern = new RegExp(`\\n?${managedStart}[\\s\\S]*?${managedEnd}\\n?`, "g");
  return config.replace(pattern, "\n");
}

function splitTopLevel(config) {
  const lines = config.replace(/\r\n/g, "\n").split("\n");
  const sectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (sectionIndex === -1) {
    return { topLevel: lines, sections: [] };
  }
  return {
    topLevel: lines.slice(0, sectionIndex),
    sections: lines.slice(sectionIndex),
  };
}

export function renderConfig(input, routeId) {
  const route = routeDefinitions[routeId];
  if (!route) {
    throw new Error(`Unknown route: ${routeId}`);
  }

  const withoutManagedBlock = removeManagedProviderBlock(input);
  const { topLevel, sections } = splitTopLevel(withoutManagedBlock);
  const managedKeys = /^(model|model_provider|model_catalog_json)\s*=/;
  const preservedTopLevel = topLevel.filter((line) => !managedKeys.test(line.trim()));
  while (preservedTopLevel.at(-1)?.trim() === "") {
    preservedTopLevel.pop();
  }

  const routeLines = [`model = ${JSON.stringify(route.model)}`];
  if (route.provider) {
    routeLines.push(`model_provider = ${JSON.stringify(route.provider)}`);
  }
  if (route.catalog) {
    routeLines.push(`model_catalog_json = ${JSON.stringify(route.catalog)}`);
  }

  const sectionText = sections.join("\n").trim();
  return [
    preservedTopLevel.join("\n"),
    routeLines.join("\n"),
    sectionText,
    managedProviderBlock,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .concat("\n");
}

export function detectRoute(input) {
  const { topLevel } = splitTopLevel(removeManagedProviderBlock(input));
  const text = topLevel.join("\n");
  const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  const provider = text.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? "openai";

  return (
    Object.entries(routeDefinitions).find(([, route]) => {
      const routeProvider = route.provider ?? "openai";
      return routeProvider === provider && route.model === model;
    })?.[0] ?? "unknown"
  );
}

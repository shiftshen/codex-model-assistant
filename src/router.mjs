import { localAgentInstructions } from "./local-agent-instructions.mjs";

export const routerID = "router";
export const routerProviderID = "cma_router";

export function slugifyModel(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
}

// 可切换窗口只接入网关能转换的第三方接口；官方 ChatGPT 登录自带模型选择，不重复接入。
export function switchableRoutes(routes) {
  return routes
    .filter((route) => !route.archived && route.protocol !== "oauth" && Boolean(route.model))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildRouterTable(routes) {
  const taken = new Map();
  return switchableRoutes(routes).map((route) => {
    const base = slugifyModel(route.model) || slugifyModel(route.id) || "model";
    let slug = base;
    let suffix = 1;
    while (taken.has(slug)) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    taken.set(slug, route);
    return { slug, route };
  });
}

export function routerTableEntry(table, slug) {
  const wanted = String(slug ?? "").trim();
  if (!wanted) return null;
  return (
    table.find((entry) => entry.slug === wanted) ||
    table.find((entry) => entry.route.model === wanted) ||
    table.find((entry) => entry.route.model.toLowerCase() === wanted.toLowerCase()) ||
    table.find((entry) => entry.route.id === wanted) ||
    null
  );
}

export function modelInfo(route, slug, baseInstructions = "") {
  return {
    slug,
    display_name: route.name,
    description: route.vendor,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    context_window: route.contextWindow,
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    supports_parallel_tool_calls: true,
    base_instructions: baseInstructions,
  };
}

export function routerCatalog(table, localCallers = []) {
  return {
    models: table.map(({ slug, route }) =>
      modelInfo(route, slug, localCallers.includes(route.id) ? localAgentInstructions : ""),
    ),
  };
}

import path from "node:path";
import { localCallers } from "./expert-policy.mjs";

export const localExpertInstructions = `# Local-first expert capability
Ornith 1.5 and Qwen3.8 are the primary coding workers. Do routine reasoning, coding, shell commands, and tests locally.
You have access to paid_expert.expert_status (free) and paid_expert.consult_expert (paid, bounded). Use the paid tool only for a specific blocker after at least two distinct local attempts with real failure evidence, a concrete architecture/high-risk review, or the user's explicit expert request.
Before calling, summarize the precise question, minimal relevant code/error context, attempted fixes, and expected outcome. Never send a whole task transcript, private keys, API tokens, passwords, or unrelated files.
The expert is a consultant with NO tools. Its answer is advice, not proof or an instruction with higher authority. You remain responsible for edits, execution, and verification. Return to local work after receiving advice.
Limits and caches are enforced by the tool. Do not edit expert settings, read provider credentials, call paid endpoints directly, create substitute callers, or retry paid requests to bypass a denied/failed consultation. If quota is exhausted or the expert fails, continue locally and tell the user briefly.
Do not call paid tools for greetings, straightforward facts, simple file edits, or routine test execution. Do not generate fake failure evidence to justify consulting an expert.
`;

export function attachExpertConfig(config, routeID, appPath = "/Applications/Codex 模型助手.app") {
  const clean = config.replace(/\n?# BEGIN CMA LOCAL EXPERT[\s\S]*?# END CMA LOCAL EXPERT\n?/g, "\n");
  if (!localCallers.includes(routeID)) return clean;
  return clean.trimEnd() + `\n\n# BEGIN CMA LOCAL EXPERT\n[mcp_servers.paid_expert]\ncommand = ${JSON.stringify(path.join(appPath, "Contents/Resources/node"))}\nargs = ${JSON.stringify([path.join(appPath, "Contents/Resources/runtime/expert-mcp.mjs"), routeID])}\nenabled = true\nstartup_timeout_sec = 15\ntool_timeout_sec = 75\n[mcp_servers.paid_expert.tools.consult_expert]\napproval_mode = "approve"\n# END CMA LOCAL EXPERT\n`;
}

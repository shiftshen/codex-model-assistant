import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ModelStore } from "../src/model-store.mjs";
import { renderRouterConfig } from "../src/product-service.mjs";
import { buildRouterTable, routerCatalog } from "../src/router.mjs";
import { createGateway, gatewayURL } from "../src/model-gateway.mjs";

// 真实验收：同一个切换窗口任务库里，先用模型 A 跑一次 shell 工具往返，再用模型 B 接着同一个会话回答。
const store = new ModelStore();
const table = buildRouterTable((await store.read()).routes);
const [firstID, secondID] = process.argv.slice(2);
const first = table.find((entry) => entry.route.id === firstID);
if (!first) throw new Error(`切换窗口里没有模型 ${firstID}；当前可选：${table.map((entry) => entry.route.id).join(", ")}`);
const second = table.find((entry) => entry.route.id === secondID) || table.find((entry) => entry.slug !== first.slug);
if (!second) throw new Error("至少需要两个可用模型才能验收切换");

// 默认起一个临时网关；设置 CMA_GATEWAY 时直接验收正在运行的本机网关。
const external = process.env.CMA_GATEWAY || "";
const port = 18798;
const baseURL = external || `http://127.0.0.1:${port}`;
const server = external ? null : createGateway(store);
if (server) await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const home = await fs.mkdtemp(path.join(os.tmpdir(), "cma-switch-"));
await fs.writeFile(path.join(home, "model-catalog.json"), JSON.stringify(routerCatalog(table)), { mode: 0o600 });
const config = renderRouterConfig("approval_policy = \"never\"\n", { model: first.slug, catalogPath: path.join(home, "model-catalog.json") }).replaceAll(gatewayURL, baseURL);
await fs.writeFile(path.join(home, "config.toml"), config, { mode: 0o600 });

const transcript = [];
async function run(args, timeoutMs) {
  const child = spawn("/Applications/Codex.app/Contents/Resources/codex", ["exec", ...args], {
    env: { ...process.env, CODEX_HOME: home, CMA_ROUTE_TOKEN: await store.token("router") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => transcript.push(chunk.toString()));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  return code;
}

const firstCode = await run(["--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-m", first.slug, "Use the shell tool to run pwd. Then reply exactly SWITCH_TOOL_OK followed by the path. Do not modify files."], 180000);
const mark = transcript.length;
const secondCode = await run(["resume", "--last", "--all", "--skip-git-repo-check", "-c", "sandbox_mode=read-only", "-c", "approval_policy=never", "-m", second.slug, "Without calling any tool, repeat the exact marker and path from my previous message."], 180000);

const text = transcript.join("");
const resumed = transcript.slice(mark).join("");
const outputPath = path.resolve("output", `switch-${first.route.id}-${second.route.id}.log`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, text, { mode: 0o600 });
await fs.rm(home, { recursive: true, force: true });
if (server) await new Promise((resolve) => server.close(resolve));

const toolRoundtrip = firstCode === 0 && /succeeded in/.test(text) && text.includes("SWITCH_TOOL_OK");
const historyCarried = secondCode === 0 && /SWITCH_TOOL_OK/.test(resumed) && /\/Users\/shift/.test(resumed) && !/succeeded in/.test(resumed);
const ok = toolRoundtrip && historyCarried;
console.log(JSON.stringify({ first: first.route.id, firstSlug: first.slug, second: second.route.id, secondSlug: second.slug, ok, toolRoundtrip, historyCarried, outputPath }));
process.exitCode = ok ? 0 : 1;

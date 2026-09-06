import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService, renderProductConfig } from "../src/product-service.mjs";

const store = new ModelStore();
const service = new ProductService(store);
const routeID = process.argv[2] || "deepseek-flash";
const prepared = await service.prepare(routeID);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cma-smoke-"));
const config = renderProductConfig("", prepared.route, path.join(prepared.homePath, "model-catalog.json"));
await fs.writeFile(path.join(temporary, "config.toml"), config, { mode: 0o600 });
const outputPath = path.resolve("output", `live-${routeID}.log`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const transcript = [];
const child = spawn("/Applications/Codex.app/Contents/Resources/codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "Use the shell tool to run pwd. Then reply exactly TOOL_ROUNDTRIP_OK followed by the path. Do not modify files."], {
  env: { ...process.env, CODEX_HOME: temporary, CMA_ROUTE_TOKEN: await store.token(routeID) },
  stdio: ["ignore", "pipe", "pipe"],
});
const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => transcript.push(chunk.toString()));
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
clearTimeout(timer);
await fs.writeFile(outputPath, transcript.join(""), { mode: 0o600 });
await fs.rm(temporary, { recursive: true, force: true });
const ok = code === 0 && transcript.join("").includes("TOOL_ROUNDTRIP_OK") && /succeeded in/.test(transcript.join(""));
console.log(JSON.stringify({ routeID, protocol: prepared.route.protocol, ok, code, outputPath }));
process.exitCode = ok ? 0 : 1;

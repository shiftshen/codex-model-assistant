import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService, renderProductConfig } from "../src/product-service.mjs";
import { attachExpertConfig, localExpertInstructions } from "../src/local-expert-config.mjs";
import { ExpertService } from "../src/expert-service.mjs";

const caller = process.argv[2] || "s5090-qwen";
const simple = process.argv[3] === "simple";
const store = new ModelStore();
const experts = new ExpertService(store);
const initialUsage = (await experts.status(caller)).usage;
const before = initialUsage.calls;
const callerBefore = initialUsage.callerCalls;
const startedAt = Date.now();
const prepared = await new ProductService(store).prepare(caller);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cma-expert-live-"));
const config = attachExpertConfig(renderProductConfig("", prepared.route, path.join(prepared.homePath, "model-catalog.json")), caller);
await fs.writeFile(path.join(directory, "config.toml"), config, { mode: 0o600 });
await fs.writeFile(path.join(directory, "AGENTS.md"), localExpertInstructions, { mode: 0o600 });
const prompt = simple
  ? "What is 2+2? This is a trivial local-only check. Do not consult any paid expert. Reply exactly LOCAL_ONLY_OK 4."
  : "This is an explicitly user-requested integration test of the paid_expert capability. Call paid_expert.consult_expert exactly once with reason user_requested. Ask: How should an SQLite ledger reserve a daily paid-API quota atomically before a request, and handle a timeout without automatically retrying? Provide context: two local agent processes share one SQLite file; calls may time out after reaching the provider. Set attempts to an empty array and evidence to: user explicitly requested this integration test. Do not call other paid endpoints or modify files. After the tool returns, YOU as the local model summarize its advice in two short sentences and finish with LOCAL_EXPERT_ROUNDTRIP_OK. If the tool fails report the error honestly and do not retry.";
const logs = [];
const child = spawn("/Applications/Codex.app/Contents/Resources/codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", prompt], {
  cwd: directory,
  env: { ...process.env, CODEX_HOME: directory, CMA_ROUTE_TOKEN: await store.token(caller) },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => logs.push(chunk.toString()));
const timer = setTimeout(() => child.kill("SIGTERM"), 360000);
const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
clearTimeout(timer);
const transcript = logs.join("");
const outputPath = path.resolve("output", `expert-${caller}${simple ? "-simple" : ""}.log`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, transcript, { mode: 0o600 });
const finalUsage = (await experts.status(caller)).usage;
const after = finalUsage.calls;
const marker = simple ? "LOCAL_ONLY_OK 4" : "LOCAL_EXPERT_ROUNDTRIP_OK";
const completed = finalUsage.records.some((record) => record.caller === caller && record.createdMs >= startedAt && record.status === "completed");
const ok = code === 0 && transcript.split("\ncodex\n").at(-1).includes(marker) && (simple ? finalUsage.callerCalls === callerBefore : /consult_expert \(completed\)/.test(transcript) && completed && finalUsage.callerCalls - callerBefore === 1);
await fs.rm(directory, { recursive: true, force: true });
console.log(JSON.stringify({ ok, caller, model: prepared.route.model, simple, paidCallsBefore: before, paidCallsAfter: after, callerCallsBefore: callerBefore, callerCallsAfter: finalUsage.callerCalls, code, outputPath }));
process.exitCode = ok ? 0 : 1;

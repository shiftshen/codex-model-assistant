import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";

const gatewayPath = fileURLToPath(new URL("../src/model-gateway.mjs", import.meta.url));

// 历史问题：日志里堆了 117 次 `Unhandled 'error' event` + EADDRINUSE 崩溃栈。
// 原因是 error 监听挂在主程序块里，别处创建的 server 一旦撞端口就直接崩。
// 这里钉两条：结构上一定有监听；真的起进程撞端口也不能出现崩溃栈。
test("createGateway 出来的 server 一定有 error 监听（结构上不可能出现无人处理的 error）", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-gw-err-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = createGateway(new ModelStore(root));
  assert.ok(server.listenerCount("error") >= 1, "没有 error 监听的 server 会在撞端口时直接崩");
  server.close();
});

test("起两个网关实例撞端口时优雅退出，不再抛 Unhandled 'error'", async () => {
  const runOnce = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [gatewayPath], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    // 起得来就一直 listen（本机没网关时的情况），到点杀掉，同样算「没崩」。
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(output); }, 2500);
    child.on("exit", () => { clearTimeout(timer); resolve(output); });
  });

  const outputs = [await runOnce(), await runOnce()];
  for (const output of outputs) {
    assert.ok(!/Unhandled 'error' event/.test(output), `不该出现崩溃栈，实际输出：${output.slice(0, 300)}`);
    assert.ok(!/^\s*throw er;/m.test(output), `不该出现 Node 的未捕获异常输出：${output.slice(0, 300)}`);
    // 撞端口时必须给一句人话，而不是一串栈
    if (/EADDRINUSE/.test(output)) assert.match(output, /端口 18793 被占用/);
  }
});

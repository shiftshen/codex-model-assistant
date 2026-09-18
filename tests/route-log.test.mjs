import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway, noteFallback, noteRoute } from "../src/model-gateway.mjs";
import { ProductService, readFallbackEvents, readRecentRoutes, readUsageReport } from "../src/product-service.mjs";

// 这一组测试是为了钉住一个真实踩过的坑：
// model-gateway 里 import 的是 node:fs（回调版），但「留痕」函数用 await fs.readFile / fs.writeFile 写文件。
// 那两个调用会直接抛 TypeError（缺少 callback），又被外层 catch{} 吞掉——
// 结果是一条记录都没写下来，而调用方以为成功了。当时我据此告诉用户「fallback 0 次」，
// 其实那个 0 什么都不能证明。所以必须有测试真的去读文件，而不是只看返回值。
async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-route-log-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

// 网关是先回响应、再把「走了谁」写进文件（写盘不该压在请求延迟上），
// 所以客户端拿到响应时记录可能还没落盘——测试要等一下，不能立刻断言。
async function waitFor(check, { timeout = 2000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("noteRoute / noteFallback 真的把记录写进磁盘（不是只有返回值）", async (context) => {
  const store = await fixture(context);
  await noteRoute(store.root, { id: "r1", name: "路由一", endpoint: "https://opencode.ai/zen/go/v1" }, { model: "m" });
  await noteFallback(store.root, { id: "a", name: "A" }, { id: "b", name: "B" }, "测试原因");

  const routes = JSON.parse(await fs.readFile(path.join(store.root, "route-log.json"), "utf8"));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].route, "r1");
  assert.equal(routes[0].host, "opencode.ai", "应该记下真实域名，用户就是靠这个核对扣费方");

  const fallbacks = JSON.parse(await fs.readFile(path.join(store.root, "fallback-events.json"), "utf8"));
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].fromName, "A");
  assert.equal(fallbacks[0].toName, "B");
});

test("读回来的是同一批（读接口不能自己 catch 成空数组掩盖问题）", async (context) => {
  const store = await fixture(context);
  assert.deepEqual(await readRecentRoutes(store.root), []);
  await noteRoute(store.root, { id: "r1", name: "路由一", endpoint: "https://api.deepseek.com/v1" }, {});
  const routes = await waitFor(async () => {
    const list = await readRecentRoutes(store.root);
    return list.length ? list : null;
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].host, "api.deepseek.com");
});

test("首选失败改用备用时，两个文件都要留下证据，界面才看得到", async (context) => {
  const store = await fixture(context);
  let primaryHits = 0;
  const primaryURL = await listen(http.createServer((request, response) => {
    primaryHits += 1;
    request.resume();
    request.on("end", () => { response.statusCode = 500; response.end("{}"); });
  }), context);
  const fallbackURL = await listen(http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "FALLBACK_OK" } }], usage: {} }));
    });
  }), context);
  await store.read();
  await store.save({ id: "primary", name: "首选", endpoint: primaryURL, protocol: "chat", model: "primary", contextWindow: 200000, credentialID: "primary", fallback: "backup" }, 1, "k1");
  const data = await store.read();
  await store.save({ id: "backup", name: "备用", endpoint: fallbackURL, protocol: "chat", model: "backup", contextWindow: 200000, credentialID: "backup" }, data.revision, "k2");

  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  const response = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "primary", input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }], stream: false }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FALLBACK_OK/);
  assert.equal(primaryHits, 1, "首选确实被打过一次");

  const fallbacks = await waitFor(async () => {
    const list = await readFallbackEvents(store.root);
    return list.length ? list : null;
  });
  assert.equal(fallbacks.length, 1, "用了备用就必须留下记录");
  assert.equal(fallbacks[0].from, "primary");
  assert.equal(fallbacks[0].to, "backup");
  // 记的是真实失败原因，不是占位文案——用户看到「为什么换了」才有用
  assert.match(fallbacks[0].reason, /HTTP 500/);

  const routes = await readRecentRoutes(store.root);
  // 两条：首选那次确实发出去了（真的到了对方服务器、真的可能计费），然后才是备用。
  // 只记一条会掩盖「首选也被调用过」这个事实。
  assert.equal(routes.length, 2);
  assert.equal(routes[0].route, "backup");
  assert.equal(routes[0].fallback, true);
  assert.equal(routes[1].route, "primary");
  assert.equal(routes[1].fallback, false);

  // 界面拿到的就是这两份数据
  const service = new ProductService(store);
  const summary = await service.switchSummary();
  assert.equal(summary.fallbacks.length, 1);
  assert.equal(summary.recentRoutes[0].route, "backup");
});

// 用户要跟两边后台对账，需要的是「今天请求都去了谁」，不是最近 10 条。
// 这条钉住按天累计真的在写、且读得回来。
test("按天累计：今天每个上游各收到多少次请求", async (context) => {
  const store = await fixture(context);
  await noteRoute(store.root, { id: "a", name: "A", endpoint: "https://opencode.ai/zen/go/v1" }, {});
  await noteRoute(store.root, { id: "a", name: "A", endpoint: "https://opencode.ai/zen/go/v1" }, {});
  await noteRoute(store.root, { id: "b", name: "B", endpoint: "https://api.deepseek.com/v1" }, { fallback: true });

  const report = await readUsageReport(store.root, 1);
  assert.equal(report.length, 1, "只该有今天这一天的桶");
  assert.equal(report[0].total, 3);
  assert.equal(report[0].hosts["opencode.ai"], 2);
  assert.equal(report[0].hosts["api.deepseek.com"], 1);
  assert.equal(report[0].fallbacks["api.deepseek.com"], 1, "备用要单独计数，否则看不出来钱被记到了别处");

  const summary = await new ProductService(store).switchSummary();
  assert.equal(summary.todayUsage.total, 3);
});

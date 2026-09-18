import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gatewayBuild } from "../src/model-gateway.mjs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(sourceRoot, "src");

// product-service.mjs 只在助手进程里跑，网关不 import 它；改它不该被判定成“网关需要重启”。
test("网关指纹不包含它不加载的模块（改 product-service 不影响指纹）", async (context) => {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), "cma-build-"));
  context.after(() => fs.rm(copy, { recursive: true, force: true }));
  const files = (await fs.readdir(srcDir)).filter((name) => name.endsWith(".mjs"));
  for (const name of files) await fs.copyFile(path.join(srcDir, name), path.join(copy, name));
  const build = () => execFileSync(process.execPath, ["-e", "import('./model-gateway.mjs').then((m) => process.stdout.write(m.gatewayBuild))"], { cwd: copy, encoding: "utf8" }).trim();

  const before = build();
  const service = path.join(copy, "product-service.mjs");
  await fs.writeFile(service, (await fs.readFile(service, "utf8")) + "\n// 只改助手，不改网关\n");
  assert.equal(build(), before);

  // 真正被网关加载的模块一改，指纹必须变，否则就检测不出旧进程了。
  const router = path.join(copy, "router.mjs");
  await fs.writeFile(router, (await fs.readFile(router, "utf8")) + "\n// 改到网关自己的代码\n");
  assert.notEqual(build(), before);
});

test("网关指纹与目录无关：仓库源码和安装后的副本算出来一样", async (context) => {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), "cma-build-"));
  context.after(() => fs.rm(copy, { recursive: true, force: true }));
  for (const name of (await fs.readdir(srcDir)).filter((entry) => entry.endsWith(".mjs"))) {
    await fs.copyFile(path.join(srcDir, name), path.join(copy, name));
  }
  const build = () => execFileSync(process.execPath, ["-e", "import('./model-gateway.mjs').then((m) => process.stdout.write(m.gatewayBuild))"], { cwd: copy, encoding: "utf8" }).trim();
  assert.equal(build(), gatewayBuild);
  assert.match(gatewayBuild, /^[0-9a-f]{12}$/);
});

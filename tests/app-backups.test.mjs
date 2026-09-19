import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneAppBackups, pruneDirectory } from "../scripts/prune-app-backups.mjs";

async function fixture(context) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cma-backup-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const applications = path.join(base, "Applications");
  const backupDir = path.join(base, "backups");
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  return { applications, backupDir };
}

const appPath = (applications) => path.join(applications, "Model Router.app");

test("备份整理：只保留最近 N 份，更旧的删掉", async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cma-backup-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const name of ["a-1.app", "a-2.app", "a-3.app", "a-4.app"]) await fs.mkdir(path.join(base, name));
  const removed = await pruneDirectory(base, { keep: 2, match: (name) => name.startsWith("a-") });
  assert.deepEqual(removed.map((entry) => path.basename(entry)), ["a-1.app", "a-2.app"]);
  assert.deepEqual((await fs.readdir(base)).sort(), ["a-3.app", "a-4.app"]);
});

test("备份整理：dry-run 只报不改", async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cma-backup-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const name of ["a-1.app", "a-2.app", "a-3.app"]) await fs.mkdir(path.join(base, name));
  const removed = await pruneDirectory(base, { keep: 1, match: () => true, dryRun: true });
  assert.equal(removed.length, 2);
  assert.equal((await fs.readdir(base)).length, 3, "dry-run 不能真删");
});

// 历史版本每次安装都在 /Applications 里留一份 .backup-*，Finder 里就是一排文件夹。
test("安装整理：/Applications 里只留一个应用，历史备份与多余副本都清掉", async (context) => {
  const { applications, backupDir } = await fixture(context);
  await fs.mkdir(appPath(applications));
  for (const stamp of ["20260918-180058", "20260918-181010", "20260918-182031"]) {
    await fs.mkdir(`${appPath(applications)}.backup-${stamp}`);
  }
  await fs.mkdir(path.join(applications, "别的应用.app"));
  for (const stamp of ["20260918-190000", "20260918-191000", "20260918-192000"]) {
    await fs.mkdir(path.join(backupDir, `Model Router-${stamp}.app`));
  }
  await fs.mkdir(path.join(backupDir, "别的东西"));

  const result = await pruneAppBackups({ appPath: appPath(applications), backupDir, keep: 2 });
  assert.equal(result.leftovers.length, 3, "历史遗留的 .backup-* 必须都被清掉");
  assert.equal(result.trimmed.length, 1, "备份目录只留最近 2 份");
  assert.deepEqual((await fs.readdir(applications)).sort(), ["Model Router.app", "别的应用.app"]);
  assert.deepEqual((await fs.readdir(backupDir)).sort(), ["Model Router-20260918-191000.app", "Model Router-20260918-192000.app", "别的东西"]);
});

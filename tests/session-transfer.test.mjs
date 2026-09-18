import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  importConversations,
  inspectConversationStore,
  inspectGlobalProjectState,
  mergeGlobalProjectState,
  repairProjectMetadata,
  snapshotConversations,
} from "../src/session-transfer.mjs";
import { sqliteSync } from "./test-platform.mjs";

const route = { id: "deepseek-flash", model: "deepseek-flash" };
const sql = sqliteSync;
async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-transfer-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(path.join(source, "sessions"), { recursive: true });
  const rollout = path.join(source, "sessions", "original.jsonl");
  await fs.writeFile(rollout, '{"original":"KEEP_HISTORY"}\n');
  sql(path.join(source, "state_5.sqlite"), `CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT); INSERT INTO threads VALUES ('original','${rollout}','openai','gpt-6-astra','xhigh');`);
  sql(path.join(source, "thread_history_1.sqlite"), "CREATE TABLE thread_items(thread_id TEXT, item_json TEXT); INSERT INTO thread_items VALUES ('original','KEEP_HISTORY');");
  return { source, destination, rollout };
}

test("snapshot preserves IDs and history, changes only destination routing, and is repeat-safe", async (context) => {
  const { source, destination, rollout } = await fixture(context);
  const result = await snapshotConversations(source, destination, route);
  assert.equal(result.imported, 1);
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select id||'|'||model_provider||'|'||model from threads;"), "original|cma_deepseek_flash|deepseek-flash");
  assert.equal(sql(path.join(source, "state_5.sqlite"), "select model_provider from threads;"), "openai");
  const copied = sql(path.join(destination, "state_5.sqlite"), "select rollout_path from threads;");
  assert.ok(copied.startsWith(destination + path.sep));
  assert.equal(await fs.readFile(copied, "utf8"), await fs.readFile(rollout, "utf8"));
  assert.notEqual((await fs.stat(copied)).ino, (await fs.stat(rollout)).ino);
  assert.equal(sql(path.join(destination, "thread_history_1.sqlite"), "select item_json from thread_items;"), "KEEP_HISTORY");
  await fs.appendFile(copied, "NEW_DESTINATION_TURN\n");
  assert.equal((await snapshotConversations(source, destination, route)).imported, 1);
  assert.match(await fs.readFile(copied, "utf8"), /NEW_DESTINATION_TURN/);
});

test("existing unmarked destination is never overwritten", async (context) => {
  const { source, destination } = await fixture(context);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, "keep"), "existing");
  await assert.rejects(snapshotConversations(source, destination, route), /已有数据/);
  assert.equal(await fs.readFile(path.join(destination, "keep"), "utf8"), "existing");
});

test("missing rollout aborts atomically rather than claiming complete import", async (context) => {
  const { source, destination, rollout } = await fixture(context);
  await fs.rm(rollout);
  await assert.rejects(snapshotConversations(source, destination, route));
  await assert.rejects(fs.access(destination));
});

async function importFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-import-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const schema = "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, model TEXT, title TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT);";
  const history = "CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id, turn_id, item_id));";
  const projects = "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);";
  const projectRoots = "CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT, PRIMARY KEY(project_id, position, path));";
  const sections = "CREATE TABLE thread_sections(id TEXT PRIMARY KEY, name TEXT, appearance TEXT);";
  const homes = {};
  for (const name of ["first", "second"]) {
    const home = path.join(root, name);
    await fs.mkdir(path.join(home, "sessions", "2026", "01", "01"), { recursive: true });
    sql(path.join(home, "state_5.sqlite"), schema);
    sql(path.join(home, "state_5.sqlite"), projects);
    sql(path.join(home, "state_5.sqlite"), projectRoots);
    sql(path.join(home, "state_5.sqlite"), sections);
    sql(path.join(home, "thread_history_1.sqlite"), history);
    homes[name] = home;
  }
  const destination = path.join(root, "router");
  await fs.mkdir(path.join(destination, "sessions"), { recursive: true });
  sql(path.join(destination, "state_5.sqlite"), schema);
  sql(path.join(destination, "state_5.sqlite"), projects);
  sql(path.join(destination, "state_5.sqlite"), projectRoots);
  sql(path.join(destination, "state_5.sqlite"), sections);
  sql(path.join(destination, "thread_history_1.sqlite"), history);
  sql(path.join(destination, "state_5.sqlite"), "INSERT INTO threads VALUES ('own','" + path.join(destination, "sessions", "own.jsonl") + "','cma_router','own-model','自己的会话','/Users/test/alpha/router',NULL,NULL);");
  sql(path.join(homes.first, "state_5.sqlite"), "INSERT INTO projects VALUES ('proj-a','Alpha','{}',1,1,1);");
  sql(path.join(homes.first, "state_5.sqlite"), "INSERT INTO project_roots VALUES ('proj-a',0,'/Users/test/alpha');");
  sql(path.join(homes.first, "state_5.sqlite"), "INSERT INTO thread_sections VALUES ('pinned','Pinned',NULL);");
  return { homes, destination };
}

async function addThread(home, id, content, cwd = "/Users/test/alpha/project") {
  const rollout = path.join(home, "sessions", "2026", "01", "01", `rollout-${id}.jsonl`);
  await fs.writeFile(rollout, content);
  sql(path.join(home, "state_5.sqlite"), `INSERT INTO threads VALUES ('${id}','${rollout}','OpenAI','gpt-6-astra','标题 ${id}','${cwd}',NULL,NULL);`);
  sql(path.join(home, "thread_history_1.sqlite"), `INSERT INTO thread_items VALUES ('${id}','turn-1','item-1','${content.trim()}');`);
  return rollout;
}

test("导入把其他任务库的会话补进切换窗口且不改动来源", async (context) => {
  const { homes, destination } = await importFixture(context);
  const firstRollout = await addThread(homes.first, "first-thread", '{"history":"FIRST"}\n');
  await addThread(homes.first, "missing-thread", '{"history":"GONE"}\n');
  await fs.rm(path.join(homes.first, "sessions", "2026", "01", "01", "rollout-missing-thread.jsonl"));
  await addThread(homes.second, "second-thread", '{"history":"SECOND"}\n', "/Users/test/other/project");
  await addThread(homes.second, "first-thread", '{"history":"DUPLICATE"}\n');
  const report = await importConversations([homes.first, homes.second], destination, { model: "switch-slug", provider: "cma_router" });
  assert.equal(report.imported, 2);
  assert.equal(report.missingFiles, 1);
  assert.equal(report.reassignedThreads, 2);
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select count(*) from threads;"), "3");
  assert.equal(
    sql(path.join(destination, "state_5.sqlite"), "select model_provider||'|'||model from threads where id='first-thread';"),
    "cma_router|switch-slug",
  );
  const copied = sql(path.join(destination, "state_5.sqlite"), "select rollout_path from threads where id='first-thread';");
  assert.ok(copied.startsWith(destination + path.sep));
  assert.equal(await fs.readFile(copied, "utf8"), await fs.readFile(firstRollout, "utf8"));
  assert.notEqual((await fs.stat(copied)).ino, (await fs.stat(firstRollout)).ino);
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select count(*) from threads where id='missing-thread';"), "0");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select count(*) from projects;"), "1");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select name from projects where id='proj-a';"), "Alpha");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select path from project_roots where project_id='proj-a';"), "/Users/test/alpha");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select project_id from threads where id='own';"), "proj-a");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select project_id from threads where id='first-thread';"), "proj-a");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select ifnull(project_id,'') from threads where id='second-thread';"), "");
  assert.equal(
    sql(path.join(destination, "thread_history_1.sqlite"), "select count(*) from thread_items;"),
    "2",
  );
  assert.equal(sql(path.join(destination, "thread_history_1.sqlite"), "select group_concat(thread_id) from thread_items;"), "first-thread,second-thread");
  assert.equal(sql(path.join(homes.first, "state_5.sqlite"), "select model_provider from threads where id='first-thread';"), "OpenAI");
  const repeat = await importConversations([homes.first, homes.second], destination, { model: "switch-slug", provider: "cma_router" });
  assert.equal(repeat.imported, 0);
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select count(*) from threads;"), "3");
});

test("切换窗口还没有任务库时拒绝导入而不是假装成功", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-import-empty-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(importConversations([root], path.join(root, "router"), { model: "x", provider: "cma_router" }), /先打开一次切换窗口/);
});

test("可单独修复工作窗口的项目分组元数据，不重复导入会话", async (context) => {
  const { homes, destination } = await importFixture(context);
  await addThread(homes.first, "first-thread", '{"history":"FIRST"}\n');
  const before = await inspectConversationStore(destination);
  assert.equal(before.threads, 1);
  assert.equal(before.projects, 0);
  const report = await repairProjectMetadata([homes.first, homes.second], destination);
  assert.equal(report.before.projects, 0);
  assert.equal(report.after.projects, 1);
  assert.equal(report.after.projectRoots, 1);
  assert.equal(report.reassignedThreads, 1);
  assert.equal(report.after.threadsWithProject, 1);
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select count(*) from threads;"), "1");
  assert.equal(sql(path.join(destination, "state_5.sqlite"), "select name from projects where id='proj-a';"), "Alpha");
 assert.equal(sql(path.join(destination, "state_5.sqlite"), "select project_id from threads where id='own';"), "proj-a");
});

// 侧边栏「项目」分组在 .codex-global-state.json 里；下面这组用例覆盖把它并入工作窗口的合并逻辑。
const globalStateName = ".codex-global-state.json";

async function globalFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-global-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const homes = {};
  for (const name of ["first", "second"]) {
    homes[name] = path.join(root, name);
    await fs.mkdir(homes[name], { recursive: true });
  }
  const destination = path.join(root, "router");
  await fs.mkdir(destination, { recursive: true });
  return { root, homes, destination };
}

async function writeGlobal(home, data) {
  await fs.writeFile(path.join(home, globalStateName), JSON.stringify(data, null, 2));
}

async function readGlobal(home) {
  return JSON.parse(await fs.readFile(path.join(home, globalStateName), "utf8"));
}

const alpha = { id: "proj-a", name: "Alpha", rootPaths: ["/Users/test/alpha"] };
const beta = { id: "proj-b", name: "Beta", rootPaths: ["/Users/test/beta"] };

test("侧边栏分组：空工作窗口也能补出项目、归属与顺序", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await assert.rejects(fs.access(path.join(destination, globalStateName)));
  await writeGlobal(homes.first, {
    "local-projects": { "proj-a": alpha },
    "thread-project-assignments": { "thread-1": { projectId: "proj-a" } },
    "project-order": ["proj-a"],
    "thread-writable-roots": { "thread-1": "/Users/test/alpha" },
  });
  const report = await mergeGlobalProjectState([homes.first], destination);
  assert.equal(report.projectsAdded, 1);
  assert.equal(report.assignmentsAdded, 1);
  assert.equal(report.orderEntriesAdded, 1);
  assert.equal(report.wrote, true);
  assert.deepEqual(report.after, { present: true, projects: 1, assignments: 1, order: 1, writableRoots: 1 });
  const state = await readGlobal(destination);
  assert.equal(state["local-projects"]["proj-a"].name, "Alpha");
  assert.deepEqual(state["local-projects"]["proj-a"].rootPaths, ["/Users/test/alpha"]);
  assert.equal(state["thread-project-assignments"]["thread-1"].projectId, "proj-a");
  assert.deepEqual(state["project-order"], ["proj-a"]);
  assert.equal(state["thread-writable-roots"]["thread-1"], "/Users/test/alpha");
  assert.equal((await fs.stat(path.join(destination, globalStateName))).mode & 0o777, 0o600);
});

test("侧边栏分组只增不改：工作窗口已有的项目不被来源改写", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await writeGlobal(destination, { "local-projects": { "proj-a": { ...alpha, name: "我的名字" } } });
  await writeGlobal(homes.first, {
    "local-projects": { "proj-a": { ...alpha, name: "来源名字" }, "proj-b": beta },
    "project-order": ["proj-a", "proj-b"],
  });
  const report = await mergeGlobalProjectState([homes.first], destination);
  assert.equal(report.projectsAdded, 1);
  // 同 ID 的项目按「已有优先」处理，不覆盖、也不算跨窗口重复。
  assert.equal(report.projectsDeduped, 0);
  const state = await readGlobal(destination);
  assert.equal(state["local-projects"]["proj-a"].name, "我的名字");
  assert.equal(state["local-projects"]["proj-b"].name, "Beta");
  assert.deepEqual(state["project-order"], ["proj-a", "proj-b"]);
});

test("侧边栏分组按目录去重，重复项目的会话归属被改写到保留项目", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await writeGlobal(homes.first, {
    "local-projects": { keep: { id: "keep", name: "ChineseChess", rootPaths: ["/Users/test/chess/"] } },
    "thread-project-assignments": { "thread-1": { projectId: "keep" } },
    "project-order": ["keep"],
    "pinned-project-ids": ["keep"],
  });
  await writeGlobal(homes.second, {
    "local-projects": { dup: { id: "dup", name: "ChineseChess", rootPaths: ["/Users/test/chess"] } },
    "thread-project-assignments": { "thread-2": { projectId: "dup" } },
    "project-order": ["dup"],
    "pinned-project-ids": ["dup"],
    "project-appearances": { dup: { color: "red" } },
  });
  const report = await mergeGlobalProjectState([homes.first, homes.second], destination);
  assert.equal(report.projectsAdded, 1);
  assert.equal(report.projectsDeduped, 1);
  assert.equal(report.assignmentsRemapped, 1);
  assert.equal(report.orderEntriesAdded, 1);
  const state = await readGlobal(destination);
  assert.deepEqual(Object.keys(state["local-projects"]), ["keep"]);
  assert.equal(state["thread-project-assignments"]["thread-1"].projectId, "keep");
  assert.equal(state["thread-project-assignments"]["thread-2"].projectId, "keep");
  assert.deepEqual(state["project-order"], ["keep"]);
  assert.deepEqual(state["pinned-project-ids"], ["keep"]);
  assert.deepEqual(state["project-appearances"], { keep: { color: "red" } });
});

test("侧边栏分组不覆盖工作窗口已有的会话归属与目录映射", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await writeGlobal(destination, {
    "local-projects": { "proj-a": alpha, "proj-b": beta },
    "thread-project-assignments": { "thread-1": { projectId: "proj-a" } },
    "thread-writable-roots": { "thread-1": "/Users/test/alpha" },
  });
  await writeGlobal(homes.first, {
    "local-projects": { "proj-a": alpha, "proj-b": beta },
    "thread-project-assignments": { "thread-1": { projectId: "proj-b" }, "thread-2": { projectId: "proj-b" } },
    "thread-writable-roots": { "thread-1": "/Users/test/beta" },
  });
  const report = await mergeGlobalProjectState([homes.first], destination);
  assert.equal(report.assignmentsAdded, 1);
  assert.equal(report.assignmentsSkipped, 1);
  const state = await readGlobal(destination);
  assert.equal(state["thread-project-assignments"]["thread-1"].projectId, "proj-a");
  assert.equal(state["thread-project-assignments"]["thread-2"].projectId, "proj-b");
  assert.equal(state["thread-writable-roots"]["thread-1"], "/Users/test/alpha");
});

test("侧边栏分组重复合并是幂等的，第二次不改动文件", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await writeGlobal(destination, {});
  await writeGlobal(homes.first, {
    "local-projects": { "proj-a": alpha },
    "thread-project-assignments": { "thread-1": { projectId: "proj-a" } },
    "project-order": ["proj-a"],
    "pinned-project-ids": ["proj-a"],
  });
  const file = path.join(destination, globalStateName);
  const first = await mergeGlobalProjectState([homes.first], destination);
  assert.equal(first.wrote, true);
  const afterFirst = await fs.readFile(file, "utf8");
  const second = await mergeGlobalProjectState([homes.first], destination);
  assert.equal(second.wrote, false);
  assert.equal(second.projectsAdded, 0);
  assert.equal(second.projectsDeduped, 0);
  assert.equal(second.assignmentsAdded, 0);
  assert.equal(second.orderEntriesAdded, 0);
  assert.equal(second.pinnedAdded, 0);
  assert.equal(second.legacyMappingsAdded, 0);
  assert.equal(await fs.readFile(file, "utf8"), afterFirst);
  assert.equal((await fs.readdir(destination)).filter((entry) => entry.includes(".bak-")).length, 1);
});

test("侧边栏分组在全局状态损坏时中止，不落盘也不留备份", async (context) => {
  const { homes, destination } = await globalFixture(context);
  const broken = '{"local-projects": {';
  const file = path.join(destination, globalStateName);
  await fs.writeFile(file, broken);
  await writeGlobal(homes.first, { "local-projects": { "proj-a": alpha } });
  const sourceBefore = await fs.readFile(path.join(homes.first, globalStateName), "utf8");
  await assert.rejects(mergeGlobalProjectState([homes.first], destination), /不是有效 JSON/);
  assert.equal(await fs.readFile(file, "utf8"), broken);
  assert.deepEqual(await fs.readdir(destination), [globalStateName]);
  assert.equal(await fs.readFile(path.join(homes.first, globalStateName), "utf8"), sourceBefore);
});

test("侧边栏分组：来源文件损坏时同样中止而不是写入半份数据", async (context) => {
  const { homes, destination } = await globalFixture(context);
  await writeGlobal(destination, { "local-projects": { "proj-a": alpha } });
  await writeGlobal(homes.first, { "local-projects": { "proj-b": beta } });
  await fs.writeFile(path.join(homes.second, globalStateName), "not json at all");
  const before = await fs.readFile(path.join(destination, globalStateName), "utf8");
  await assert.rejects(mergeGlobalProjectState([homes.first, homes.second], destination), /不是有效 JSON/);
  assert.equal(await fs.readFile(path.join(destination, globalStateName), "utf8"), before);
  assert.deepEqual(await fs.readdir(destination), [globalStateName]);
});

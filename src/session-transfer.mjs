import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { atomicJSON, validID } from "./model-store.mjs";
import { runCommandWithInput, sqliteExecutable } from "./platform-runtime.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function sqlite(database, statement) {
  return (await runCommandWithInput(sqliteExecutable(), ["-cmd", ".timeout 10000", database], statement, { maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}

async function exists(target) {
  try { await fs.access(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function tableColumns(database, table) {
  const names = JSON.parse(await sqlite(database, `SELECT json_group_array(name) FROM pragma_table_info(${quote(table)});`) || "[]");
  return Array.isArray(names) ? names : [];
}

// 本窗口任务库里真实存在的会话 id。「这个项目还有没有对话」全靠它判断：
// 归属指向一个不存在的会话时，侧边栏就会出现只有项目名、点开空空的假象。
export async function readThreadIDs(homePath) {
  const database = path.join(homePath, "state_5.sqlite");
  if (!(await exists(database))) return new Set();
  if (!(await tableColumns(database, "threads")).includes("id")) return new Set();
  const ids = JSON.parse((await sqlite(database, "SELECT json_group_array(id) FROM threads;")) || "[]");
  return new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
}

async function sameColumns(leftDB, rightDB, table) {
  const [left, right] = await Promise.all([tableColumns(leftDB, table), tableColumns(rightDB, table)]);
  return left.length && left.join() === right.join();
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function values(rows) {
  return rows.map((row) => `(${row.map((value) => quote(value)).join(", ")})`).join(", ");
}

// 桌面端左侧「项目」分组读的是 CODEX_HOME/.codex-global-state.json 的顶层键，不是 SQLite。
// 这里把这些键从各来源并入工作窗口；只增不改，来源一律只读。
const globalStateFile = ".codex-global-state.json";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRoot(value) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  return text === "" ? "/" : text;
}

// 同一目录集合视为同一个项目，用来去掉各窗口重复建立的同名项目。
function projectIdentity(projectID, project) {
  const roots = [...new Set(asList(asObject(project).rootPaths).map(normalizeRoot).filter(Boolean))].sort();
  return roots.length ? `root:${roots.join("|")}` : `id:${projectID}`;
}

function hostKeyOf(homePath) {
  return `local:${path.resolve(homePath)}`;
}

async function readGlobalState(homePath) {
  const file = path.join(path.resolve(homePath), globalStateFile);
  try {
    return { file, data: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { file, data: null };
    if (error instanceof SyntaxError) throw new Error(`全局状态文件不是有效 JSON，已停止以免覆盖：${file}`);
    throw error;
  }
}

export async function inspectGlobalProjectState(homePath) {
  const { data } = await readGlobalState(homePath);
  if (!data) return { present: false, projects: 0, assignments: 0, order: 0, writableRoots: 0 };
  return {
    present: true,
    projects: Object.keys(asObject(data["local-projects"])).length,
    assignments: Object.keys(asObject(data["thread-project-assignments"])).length,
    order: asList(data["project-order"]).length,
    writableRoots: Object.keys(asObject(data["thread-writable-roots"])).length,
  };
}

// 把各来源的项目分组并入工作窗口的全局状态。只新增缺失的项目、归属和目录映射：
// 工作窗口已有的项目与归属永远优先，来源文件不会被改写。
export async function mergeGlobalProjectState(sources, destination, options = {}) {
  destination = path.resolve(destination);
  const prefer = (options.prefer?.length ? options.prefer : sources).map((entry) => path.resolve(entry));
  const order = [...new Set([destination, ...prefer])];
  const target = await readGlobalState(destination);
  if (!target.data && options.requireExisting) throw new Error("请先打开一次工作窗口，让 Codex 建好全局状态");
  const state = target.data ?? {};
  const report = {
    destination,
    sourcesScanned: 0,
    sourcesUsed: [],
    projectsAdded: 0,
    projectsDeduped: 0,
    assignmentsAdded: 0,
    assignmentsSkipped: 0,
    assignmentsPruned: 0,
    projectsPruned: 0,
    assignmentsRemapped: 0,
    orderEntriesAdded: 0,
    orderEntriesRemoved: 0,
    pinnedAdded: 0,
    pinnedRemoved: 0,
    legacyMappingsAdded: 0,
    wrote: false,
  };

  const projects = { ...asObject(state["local-projects"]) };
  const assignments = { ...asObject(state["thread-project-assignments"]) };
  let projectOrder = [...asList(state["project-order"])];
  const pinned = [...asList(state["pinned-project-ids"])];
  const appearances = { ...asObject(state["project-appearances"]) };
  const writableRoots = { ...asObject(state["thread-writable-roots"]) };
  const rootHints = { ...asObject(state["thread-workspace-root-hints"]) };

  // 传了 existingThreads 就按「本窗口真的有这条会话」过滤：没传则保持原来的「只增不改」行为。
  const existingThreads = options.existingThreads instanceof Set ? options.existingThreads : null;
  const threadAlive = (id) => !existingThreads || existingThreads.has(String(id));
  if (existingThreads) {
    for (const threadID of Object.keys(assignments)) {
      if (threadAlive(threadID)) continue;
      delete assignments[threadID];
      report.assignmentsPruned += 1;
    }
  }

  const identityOwner = new Map();
  const dropped = new Map();
  const register = (projectID, project) => {
    const identity = projectIdentity(projectID, project);
    const kept = identityOwner.get(identity);
    if (kept === undefined) { identityOwner.set(identity, projectID); return { added: true, kept: projectID }; }
    if (kept === projectID) return { added: false, kept };
    dropped.set(projectID, kept);
    return { added: false, kept, duplicate: true };
  };

  // 目标已有的项目先登记，保证去重时它们胜出。
  for (const [id, project] of Object.entries(projects)) register(id, project);

  const remap = (projectID) => {
    let current = String(projectID ?? "");
    const seen = new Set();
    while (dropped.has(current) && !seen.has(current)) {
      seen.add(current);
      current = dropped.get(current);
    }
    return current;
  };

  const hostKey = hostKeyOf(destination);
  const legacyKey = "app-server-project-id-by-legacy-project-id-by-host";
  const mergedLegacy = { ...asObject(asObject(state[legacyKey])[hostKey]) };

  for (const home of order) {
    if (home === destination) continue;
    const { data } = await readGlobalState(home);
    if (!data) continue;
    report.sourcesScanned += 1;
    report.sourcesUsed.push(home);
    const incomingProjects = asObject(data["local-projects"]);
    for (const [id, project] of Object.entries(incomingProjects)) {
      const result = register(id, project);
      if (result.added) { projects[id] = project; report.projectsAdded += 1; }
      else if (result.duplicate) report.projectsDeduped += 1;
    }
    for (const [threadID, value] of Object.entries(asObject(data["thread-project-assignments"]))) {
      if (!value || typeof value !== "object") continue;
      const mapped = remap(value.projectId);
      if (!mapped) continue;
      // 本窗口没有这条会话就别写归属，否则会留下一个点开空空的项目名。
      if (!threadAlive(threadID)) { report.assignmentsSkipped += 1; continue; }
      if (assignments[threadID]) { report.assignmentsSkipped += 1; continue; }
      assignments[threadID] = { ...value, projectId: mapped };
      report.assignmentsAdded += 1;
      if (mapped !== value.projectId) report.assignmentsRemapped += 1;
    }
    for (const id of asList(data["project-order"])) {
      const mapped = remap(id);
      if (!mapped || projectOrder.includes(mapped)) continue;
      projectOrder.push(mapped);
      report.orderEntriesAdded += 1;
    }
    for (const id of asList(data["pinned-project-ids"])) {
      const mapped = remap(id);
      if (!mapped || pinned.includes(mapped)) continue;
      pinned.push(mapped);
      report.pinnedAdded += 1;
    }
    for (const [id, value] of Object.entries(asObject(data["project-appearances"]))) {
      const mapped = remap(id);
      if (!mapped || appearances[mapped] !== undefined) continue;
      appearances[mapped] = value;
    }
    for (const key of ["thread-writable-roots", "thread-workspace-root-hints"]) {
      const incoming = asObject(data[key]);
      const targetMap = key === "thread-writable-roots" ? writableRoots : rootHints;
      for (const [threadID, value] of Object.entries(incoming)) {
        if (targetMap[threadID] === undefined) targetMap[threadID] = value;
      }
    }
    for (const [legacyID, serverID] of Object.entries(asObject(asObject(data[legacyKey])[hostKeyOf(home)]))) {
      if (dropped.has(legacyID) || mergedLegacy[legacyID] !== undefined) continue;
      mergedLegacy[legacyID] = serverID;
      report.legacyMappingsAdded += 1;
    }
  }

  // 一个会话都没落上的项目直接去掉：留着只会在侧边栏显示成「暂无聊天」的空项目。
  // 只有按本窗口会话过滤时才做，避免在「只增不改」的调用里误删用户已有分组。
  const empty = new Set();
  if (existingThreads) {
    const used = new Set(Object.values(assignments).map((value) => remap(value.projectId)));
    for (const id of Object.keys(projects)) {
      if (used.has(id)) continue;
      empty.add(id);
      delete projects[id];
    }
    report.projectsPruned = empty.size;
  }

  // 被合并掉或被清空的项目不能继续留在排序与固定列表里。
  const filteredOrder = projectOrder.filter((id) => !dropped.has(id) && !empty.has(id));
  report.orderEntriesRemoved = projectOrder.length - filteredOrder.length;
  projectOrder = filteredOrder;
  for (const [id] of Object.entries(projects)) {
    if (!projectOrder.includes(id)) { projectOrder.push(id); report.orderEntriesAdded += 1; }
  }
  // 「置顶」和外观也不能留空项目，否则置顶区同样只剩一个空名字。
  const keptPinned = pinned.filter((id) => !dropped.has(id) && !empty.has(id));
  report.pinnedRemoved = pinned.length - keptPinned.length;
  pinned.length = 0;
  pinned.push(...keptPinned);
  for (const id of Object.keys(appearances)) {
    if (empty.has(id) || dropped.has(id)) delete appearances[id];
  }

  const next = { ...state };
  const put = (key, value) => {
    const known = Object.prototype.hasOwnProperty.call(state, key);
    const empty = Array.isArray(value) ? !value.length : !Object.keys(asObject(value)).length;
    if (empty && !known) return;
    if (JSON.stringify(state[key] ?? null) === JSON.stringify(value ?? null)) return;
    next[key] = value;
    report.wrote = true;
  };
  put("local-projects", projects);
  put("thread-project-assignments", assignments);
  put("project-order", projectOrder);
  put("pinned-project-ids", pinned);
  put("project-appearances", appearances);
  put("thread-writable-roots", writableRoots);
  put("thread-workspace-root-hints", rootHints);
  if (report.legacyMappingsAdded) put(legacyKey, { ...asObject(state[legacyKey]), [hostKey]: mergedLegacy });

  if (report.wrote && !options.dryRun) {
    if (target.data) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.copyFile(target.file, `${target.file}.bak-${stamp}`);
      const folder = path.dirname(target.file);
      const name = path.basename(target.file);
      const backups = (await fs.readdir(folder)).filter((entry) => entry.startsWith(`${name}.bak-`)).sort();
      for (const stale of backups.slice(0, Math.max(0, backups.length - 5))) await fs.rm(path.join(folder, stale), { force: true });
    }
    await atomicJSON(target.file, next);
  }
  report.before = options.before ?? null;
  report.after = await inspectGlobalProjectState(destination);
  return report;
}

async function mergeProjectMetadata(destinationState, sourceState, summary) {
  const available = [];
  for (const table of ["projects", "project_roots", "thread_sections"]) {
    if (await sameColumns(destinationState, sourceState, table)) available.push(table);
  }
  if (!available.length) return;
  const statements = [`ATTACH DATABASE ${quote(sourceState)} AS incoming;`];
  if (available.includes("projects")) {
    statements.push("INSERT OR IGNORE INTO main.projects SELECT * FROM incoming.projects;");
    summary.projectsMerged = true;
  }
  if (available.includes("project_roots")) {
    statements.push("INSERT OR IGNORE INTO main.project_roots SELECT * FROM incoming.project_roots;");
    summary.projectRootsMerged = true;
  }
  if (available.includes("thread_sections")) {
    statements.push("INSERT OR IGNORE INTO main.thread_sections SELECT * FROM incoming.thread_sections;");
  }
  await sqlite(destinationState, statements.join("\n"));
}

async function backfillThreadProjects(state) {
  const threadColumns = await tableColumns(state, "threads");
  if (!threadColumns.includes("project_id") || !threadColumns.includes("cwd")) return 0;
  const pendingQuery = `
    SELECT count(*)
    FROM threads
    WHERE (project_id IS NULL OR project_id = '')
      AND cwd IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM project_roots
        WHERE threads.cwd = project_roots.path
           OR threads.cwd LIKE project_roots.path || '/%'
      );
  `;
  const pending = Number(await sqlite(state, pendingQuery) || "0");
  if (!pending) return 0;
  await sqlite(state, `
    UPDATE threads
    SET project_id = (
      SELECT project_roots.project_id
      FROM project_roots
      WHERE threads.cwd = project_roots.path
         OR threads.cwd LIKE project_roots.path || '/%'
      ORDER BY length(project_roots.path) DESC, project_roots.position ASC
      LIMIT 1
    )
    WHERE (project_id IS NULL OR project_id = '')
      AND cwd IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM project_roots
        WHERE threads.cwd = project_roots.path
           OR threads.cwd LIKE project_roots.path || '/%'
      );
  `);
  const remaining = Number(await sqlite(state, pendingQuery) || "0");
  return Math.max(0, pending - remaining);
}

export async function inspectConversationStore(homePath) {
  const state = path.join(path.resolve(homePath), "state_5.sqlite");
  if (!(await exists(state))) return { ready: false, threads: 0, projects: 0, projectRoots: 0, sections: 0 };
  const threadColumns = await tableColumns(state, "threads");
  const hasProjectID = threadColumns.includes("project_id");
  const hasSectionID = threadColumns.includes("thread_section_id");
  const payload = await sqlite(state, `
    SELECT json_object(
      'threads', (SELECT count(*) FROM threads),
      'projects', (SELECT count(*) FROM projects),
      'projectRoots', (SELECT count(*) FROM project_roots),
      'sections', (SELECT count(*) FROM thread_sections),
      'threadsWithProject', ${hasProjectID ? "(SELECT count(*) FROM threads WHERE project_id IS NOT NULL)" : "0"},
      'threadsWithSection', ${hasSectionID ? "(SELECT count(*) FROM threads WHERE thread_section_id IS NOT NULL)" : "0"}
    );
  `);
  return { ready: true, ...(JSON.parse(payload || "{}")) };
}

export async function repairProjectMetadata(sources, destination) {
  destination = path.resolve(destination);
  const state = path.join(destination, "state_5.sqlite");
  if (!(await exists(state))) throw new Error("请先打开一次工作窗口，让 Codex 建好任务库");
  const report = {
    destination,
    scanned: 0,
    mergedFrom: 0,
    projectSources: [],
    reassignedThreads: 0,
    before: await inspectConversationStore(destination),
    globalBefore: await inspectGlobalProjectState(destination),
  };
  for (const candidate of sources.map((entry) => path.resolve(entry))) {
    if (candidate === destination) continue;
    const sourceState = path.join(candidate, "state_5.sqlite");
    if (!(await exists(sourceState))) continue;
    const summary = { source: candidate, projectsMerged: false, projectRootsMerged: false };
    report.scanned++;
    await mergeProjectMetadata(state, sourceState, summary);
    if (summary.projectsMerged || summary.projectRootsMerged) {
      report.mergedFrom++;
      report.projectSources.push(summary);
    }
  }
  report.reassignedThreads = await backfillThreadProjects(state);
  try {
    // 带上本窗口真实存在的会话：只有真有对话的项目才该出现在侧边栏。
    report.globalState = await mergeGlobalProjectState(sources, destination, { before: report.globalBefore, existingThreads: await readThreadIDs(destination) });
  } catch (error) {
    report.globalState = { destination, error: error.message, wrote: false, before: report.globalBefore, after: report.globalBefore };
  }
  report.after = await inspectConversationStore(destination);
  return report;
}

// 把来源任务库里的会话补进目标任务库：只新增目标缺失的会话，不改动来源，不覆盖目标已有会话。
export async function importConversations(sources, destination, options = {}) {
  destination = path.resolve(destination);
  const model = String(options.model || "").trim();
  const provider = String(options.provider || "cma_router").trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(provider)) throw new Error("无效的导入目标");
  const state = path.join(destination, "state_5.sqlite");
  if (!(await exists(state))) throw new Error("请先打开一次切换窗口，再导入已有会话");
  const columns = await tableColumns(state, "threads");
  const report = { destination, provider, model, imported: 0, missingFiles: 0, reassignedThreads: 0, sources: [] };
  for (const candidate of sources) {
    const source = path.resolve(candidate);
    const summary = { source, imported: 0, missingFiles: 0 };
    report.sources.push(summary);
    if (source === destination) continue;
    const sourceState = path.join(source, "state_5.sqlite");
    if (!(await exists(sourceState))) { summary.note = "没有任务库，已跳过"; continue; }
    if ((await tableColumns(sourceState, "threads")).join() !== columns.join()) { summary.note = "任务库结构不同，已跳过"; continue; }
    await mergeProjectMetadata(state, sourceState, summary);
    const pending = JSON.parse(await sqlite(state, `ATTACH DATABASE ${quote(sourceState)} AS incoming; SELECT json_group_array(json_object('id', id, 'path', rollout_path)) FROM incoming.threads WHERE id NOT IN (SELECT id FROM main.threads);`) || "[]");
    const links = [];
    for (const row of pending) {
      const relative = path.relative(source, row.path);
      const portableRelative = relative.split(path.sep).join("/");
      if (!/^(sessions|archived_sessions)\//.test(portableRelative) || portableRelative.split("/").includes("..") || path.isAbsolute(relative)) { summary.missingFiles++; continue; }
      const target = path.join(destination, relative);
      try {
        const original = await fs.lstat(row.path);
        if (!original.isFile()) { summary.missingFiles++; continue; }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(row.path, target, constants.COPYFILE_FICLONE);
        await fs.chmod(target, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        summary.missingFiles++;
        continue;
      }
      links.push([row.id, target]);
    }
    if (links.length) {
      const statements = [`ATTACH DATABASE ${quote(sourceState)} AS incoming;`, "CREATE TEMP TABLE picked(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);"];
      for (const group of chunks(links, 200)) statements.push(`INSERT INTO picked(id, rollout_path) VALUES ${values(group)};`);
      statements.push(
        "INSERT INTO main.threads SELECT * FROM incoming.threads WHERE id IN (SELECT id FROM picked);",
        `UPDATE main.threads SET rollout_path = (SELECT rollout_path FROM picked WHERE picked.id = main.threads.id), model_provider = ${quote(provider)}, model = ${quote(model)} WHERE id IN (SELECT id FROM picked);`,
        "DROP TABLE picked;",
      );
      await sqlite(state, statements.join("\n"));
      summary.imported = links.length;
      report.imported += links.length;
    }
    report.missingFiles += summary.missingFiles;
    const sourceHistory = path.join(source, "thread_history_1.sqlite");
    if (links.length && (await exists(sourceHistory))) await mergeHistory(destination, sourceHistory, links.map(([id]) => id), summary);
  }
  report.reassignedThreads = await backfillThreadProjects(state);
  // 会话导入只补 SQLite；桌面端左侧的项目分组在全局状态里，必须一起补，否则会全部掉进「最近」。
  report.globalBefore = await inspectGlobalProjectState(destination);
  try {
    // 导入完成后本窗口已经有这些会话了，同样按「真有会话」过滤，别留空项目。
    report.globalState = await mergeGlobalProjectState(sources, destination, { before: report.globalBefore, existingThreads: await readThreadIDs(destination) });
  } catch (error) {
    report.globalState = { destination, error: error.message, wrote: false, before: report.globalBefore, after: report.globalBefore };
  }
  return report;
}

// 新版 Codex 把会话正文放在 thread_history 里；这里按会话补进去，缺失时直接复制整库。
async function mergeHistory(destination, sourceHistory, ids, summary) {
  const target = path.join(destination, "thread_history_1.sqlite");
  if (!(await exists(target))) {
    await sqlite(sourceHistory, `.backup ${quote(target)}`);
    summary.history = "已复制历史正文库";
    return;
  }
  const tables = [];
  for (const table of ["thread_turns", "thread_items", "thread_history_projection_state"]) {
    if ((await tableColumns(target, table)).join() === (await tableColumns(sourceHistory, table)).join() && (await tableColumns(target, table)).length) tables.push(table);
  }
  if (!tables.length) { summary.history = "历史正文库结构不同，已跳过"; return; }
  const statements = [`ATTACH DATABASE ${quote(sourceHistory)} AS hist;`, "CREATE TEMP TABLE picked(id TEXT PRIMARY KEY);"];
  for (const group of chunks(ids, 200)) statements.push(`INSERT INTO picked(id) VALUES ${values(group.map((id) => [id]))};`);
  for (const table of tables) {
    const key = table === "thread_history_projection_state" ? "REPLACE" : "IGNORE";
    statements.push(`INSERT OR ${key} INTO main.${table} SELECT * FROM hist.${table} WHERE thread_id IN (SELECT id FROM picked);`);
  }
  statements.push("DROP TABLE picked;");
  await sqlite(target, statements.join("\n"));
  summary.history = "已补入历史正文";
}

export async function snapshotConversations(source, destination, route) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (!validID(route.id) || !route.model || source === destination) throw new Error("无效的会话迁移目标");
  try {
    const previous = JSON.parse(await fs.readFile(path.join(destination, "conversation-import.json"), "utf8"));
    if (previous.source !== source || previous.routeID !== route.id) throw new Error("已有数据来源不匹配");
    return previous;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await fs.access(destination); throw new Error("目标已有数据，拒绝覆盖现有会话"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const lock = await fs.open(`${destination}.import-lock`, "wx", 0o600);
  const staging = `${destination}.import-${randomUUID()}`;
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    const state = path.join(staging, "state_5.sqlite");
    await sqlite(path.join(source, "state_5.sqlite"), `.backup ${quote(state)}`);
    const rows = JSON.parse(await sqlite(state, "SELECT json_group_array(json_object('id',id,'path',rollout_path)) FROM threads;") || "[]");
    let missing = [];
    let imported = 0;
    for (const row of rows) {
      const relative = path.relative(source, row.path);
      const portableRelative = relative.split(path.sep).join("/");
      if (!/^(sessions|archived_sessions)\//.test(portableRelative) || portableRelative.split("/").includes("..") || path.isAbsolute(relative)) {
        throw new Error(`会话路径不在原任务库内：${row.id}`);
      }
      const target = path.join(staging, relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        const original = await fs.lstat(row.path);
        if (!original.isFile()) throw new Error(`会话不是普通文件：${row.id}`);
        await fs.copyFile(row.path, target, constants.COPYFILE_FICLONE);
        await fs.chmod(target, 0o600);
      } catch (error) {
        if (error.code === "ENOENT") { missing.push(row.id); continue; }
        throw error;
      }
      await sqlite(state, `UPDATE threads SET rollout_path=${quote(path.join(destination, relative))},model_provider=${quote(`cma_${route.id.replaceAll("-", "_")}`)},model=${quote(route.model)},reasoning_effort='medium' WHERE id=${quote(row.id)};`);
      imported++;
    }
    if (missing.length) throw new Error(`${missing.length} 个会话文件缺失，未发布迁移副本；原会话未改动`);
    for (const name of ["thread_history_1.sqlite"]) {
      try { await fs.access(path.join(source, name)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      await sqlite(path.join(source, name), `.backup ${quote(path.join(staging, name))}`);
    }
    for (const name of ["session_index.jsonl", ".codex-global-state.json", "AGENTS.md"]) {
      try { await fs.copyFile(path.join(source, name), path.join(staging, name)); await fs.chmod(path.join(staging, name), 0o600); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (await sqlite(state, "PRAGMA quick_check;") !== "ok") throw new Error("迁移索引校验失败");
    const result = { source, routeID: route.id, model: route.model, imported, importedAt: new Date().toISOString(), originalUnchanged: true };
    await atomicJSON(path.join(staging, "conversation-import.json"), result);
    await fs.rename(staging, destination);
    return result;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await lock.close();
    await fs.rm(`${destination}.import-lock`, { force: true });
  }
}

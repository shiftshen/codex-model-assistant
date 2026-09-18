import { ModelStore, atomicJSON, validID } from "./model-store.mjs";
import path from "node:path";
import os from "node:os";
import { ProductService } from "./product-service.mjs";
import { limitedJSON } from "./model-gateway.mjs";
import { ExpertService } from "./expert-service.mjs";
import { readExpertPolicy, saveExpertPolicy } from "./expert-policy.mjs";
import { legacyWindowID } from "./window-registry.mjs";
import { applyCleanup, cleanupPlan, describePlan, diskUsage } from "./disk-cleanup.mjs";

const store = new ModelStore();
const service = new ProductService(store);
const [command = "library", id] = process.argv.slice(2);

// 官方库永远是权威、也只读：副本判定拿它当基准，清理绝不动它。
function officialHome() {
  return path.join(os.homedir(), ".codex");
}

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${index === 0 ? size : size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

async function main() {
  if (command === "library") { await store.read(); await service.migrateSecrets(); return { ...(await store.publicData()), expertPolicy: await readExpertPolicy(store), localStatus: await service.localRuntimeStatus(), ...(await service.switchSummary()) }; }
  if (command === "local-status") return { localStatus: await service.localRuntimeStatus() };
  if (command === "expert-status") {
    const result = await new ExpertService(store).status();
    return { expertPolicy: result.policy, expertUsage: result.usage, localStatus: await service.localRuntimeStatus(), message: "专家策略和今日额度已更新" };
  }
  if (command === "expert-save") {
    const input = await limitedJSON(process.stdin, 64000);
    await saveExpertPolicy(store, input);
    const result = await new ExpertService(store).status();
    return { expertPolicy: result.policy, expertUsage: result.usage, message: "专家策略已保存，已接入实例的下次咨询即生效" };
  }
  if (command === "expert-consult") {
    const input = await limitedJSON(process.stdin, 128000);
    const result = await new ExpertService(store).consult(id, input, { manual: true });
    return { answer: result.answer, message: `${result.cached ? "已复用缓存" : "专家已回答"} · ${result.expert}，请由本地模型继续执行和验证`, ...(await new ExpertService(store).status().then((state) => ({ expertUsage: state.usage }))), localStatus: await service.localRuntimeStatus() };
  }
  if (command === "save") {
    const input = await limitedJSON(process.stdin, 1024 * 1024);
    await store.save(input.route, input.revision, input.key, input.clearKey);
    return { ...(await store.publicData()), message: "配置已保存；密钥留空时保留原值，修改端点后需重新填写密钥" };
  }
  if (command === "archive") {
    const input = await limitedJSON(process.stdin, 1024 * 1024);
    const route = await store.route(id);
    if (id === "official") throw new Error("官方恢复入口不能归档");
    await store.save({ ...route, archived: input.archived }, input.revision);
    return { ...(await store.publicData()), message: input.archived ? "已归档，可在归档列表中恢复" : "已恢复" };
  }
  if (command === "discover") return service.discover(await store.route(id));
  if (command === "check") return service.check(id);
  if (command === "autodetect") return { ...(await service.detectProtocol(id)), ...(await store.publicData()) };
  if (command === "probe") {
    try { const result = await service.probe(id); return { ...result, ...(await store.publicData()) }; }
    catch (error) {
      if (validID(id)) await atomicJSON(path.join(store.root, "checks", `${id}.json`), { ok: false, testedAt: new Date().toISOString() });
      return { ok: false, message: error.message, ...(await store.publicData()) };
    }
  }
  if (command === "start-gateway") return service.startGateway();
  if (command === "launch") return service.launch(id);
  if (command === "continue") return service.launch(id, { continueExisting: true });
  if (command === "switch-status") return service.switchSummary();
  if (command === "windows") return service.switchSummary();
  // 新窗口：每个窗口一份独立的 CODEX_HOME + 浏览器数据目录，可以同时开多个、各自换模型。
  if (command === "new-window") return service.createWindow(id || "");
  if (command === "open-window") return service.openWindow(id || legacyWindowID);
  if (command === "rename-window") return service.renameWindow(id, process.argv[4] || "");
  if (command === "close-window") return service.closeWindow(id);
  if (command === "delete-window") return service.deleteWindow(id);
  // 接管在跑但没登记进注册表的窗口（并发建窗时代可能留下的孤儿进程）。
  if (command === "adopt-window") return service.adoptWindows(id || "all");
  // 清掉「只有项目名字、点开没聊天」的空分组（归属指向了本窗口不存在的会话）。
  if (command === "prune-empty-projects") return service.pruneEmptyProjects({ dryRun: process.argv.includes("--dry-run") });
  // 磁盘治理：先看占用、再看计划，最后必须显式 --confirm 才真删。三件事拆开，避免误删。
  if (command === "disk-usage" || command === "cleanup-plan" || command === "cleanup-apply") {
    const root = store.root;
    const runningIds = new Set([...(await service.runningWindows()).keys()]);
    const build = () => cleanupPlan({ root, officialHome: officialHome(), runningIds });
    const plan = await build();
    if (command === "disk-usage" || command === "cleanup-plan") {
      const disk = await diskUsage({ root, plan });
      return {
        disk,
        cleanupPlan: describePlan(plan),
        message: command === "disk-usage"
          ? `助手目录占用 ${humanBytes(disk.totalBytes)}，其中可回收 ${humanBytes(disk.reclaimable)}；系统剩余 ${disk.freeDiskPercent.toFixed(1)}%`
          : plan.items.length
            ? `可回收 ${humanBytes(plan.reclaimBytes)}：${plan.items.length} 个会话副本（${plan.keepOriginals.count} 条原件保留、不删）`
            : "没有可回收的会话副本",
      };
    }
    const result = await applyCleanup({ root, plan, confirm: process.argv.includes("--confirm"), runningIds });
    const after = await build();
    return {
      disk: await diskUsage({ root, plan: after }),
      cleanup: result,
      cleanupPlan: describePlan(after),
      message: result.deletedThreads
        ? `已删除 ${result.deletedThreads} 个会话副本、${result.deletedFiles} 个文件，释放 ${humanBytes(result.freedBytes)}；审计清单：${result.backupManifest}`
        : "没有需要清理的内容",
    };
  }
  // 遗留入口：等价于打开「窗口 1」。
  if (command === "switch-window") return service.launchSwitchWindow(id || "");
  if (command === "import-history") return service.importHistory(id || "all");
  if (command === "repair-work-window") return service.repairSwitchWindowMetadata(id || "all");
  if (command === "enable-switching") return { ...(await service.setSwitching(id, true)), ...(await store.publicData()) };
  if (command === "disable-switching") return { ...(await service.setSwitching(id, false)), ...(await store.publicData()) };
  if (command === "setup-official") {
    // 幂等：把官方模型作为隐藏条目加进工作窗口，账号和额度仍由官方 ChatGPT 登录决定。
    const catalog = [["官方 · GPT-6 Astra", "gpt-6-astra"], ["官方 · GPT-5.6 Sol", "gpt-5.6-sol"], ["官方 · GPT-5.6 Terra", "gpt-5.6-terra"], ["官方 · GPT-5.6 Luna", "gpt-5.6-luna"], ["官方 · GPT-5.5", "gpt-5.5"]];
    for (const [name, model] of catalog) {
      const routeID = `official-${model.replace(/[^a-z0-9]+/g, "-")}`;
      const data = await store.read();
      const existing = data.routes.find((entry) => entry.id === routeID);
      await store.save({ ...(existing || {}), id: routeID, name, vendor: "OpenAI（官方登录）", protocol: "chatgpt", model, hidden: true, archived: false, contextWindow: existing?.contextWindow ?? 200000, fallback: existing?.fallback ?? "" }, data.revision);
    }
    return { ...(await store.publicData()), message: `官方模型已加入工作窗口（默认隐藏）：${catalog.map((entry) => entry[1]).join("、")}` };
  }
  if (command === "set-fallback") {
    const data = await store.read();
    const route = data.routes.find((entry) => entry.id === id);
    if (!route) throw new Error("模型不存在");
    const fallback = process.argv[4] || "";
    await store.save({ ...route, fallback }, data.revision);
    const target = fallback ? (await store.route(fallback)).name : "不设置";
    return { ...(await store.publicData()), message: `「${route.name}」失败时改用：${target}` };
  }
  if (command === "hide") {
    const data = await store.read();
    const route = data.routes.find((entry) => entry.id === id);
    if (!route) throw new Error("模型不存在");
    await store.save({ ...route, hidden: process.argv[4] !== "off" }, data.revision);
    return { ...(await store.publicData()), message: `「${route.name}」${process.argv[4] === "off" ? "已取消隐藏" : "已隐藏（仍在工作窗口里可选）"}` };
  }
  if (command === "prepare") return service.prepare(id);
  if (command === "diagnostics") return service.diagnostics();
  if (command === "export") return { exportData: JSON.stringify(await store.read(), null, 2), message: "导出不包含 API Key 和登录凭据" };
  if (command === "import") {
    const input = await limitedJSON(process.stdin, 4 * 1024 * 1024);
    await service.importLibrary(JSON.parse(input.data), input.revision);
    return { ...(await store.publicData()), message: "已作为新模型导入，请重新填写密钥" };
  }
  throw new Error("未知操作");
}

main().then((result) => process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n")).catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }) + "\n");
  process.exitCode = 1;
});

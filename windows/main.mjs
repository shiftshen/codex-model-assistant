import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const allowedCommands = new Set([
  "library", "save", "archive", "discover", "check", "autodetect", "probe",
  "start-gateway", "launch", "open-codex", "usage-report", "recent-routes",
  "live-threads", "continue", "switch-status", "windows", "refresh-catalogs",
  "new-window", "open-window", "rename-window", "close-window", "delete-window",
  "adopt-window", "disk-usage", "cleanup-plan", "diagnostics", "export",
  "enable-switching", "disable-switching", "set-fallback", "hide"
]);

function runtimeDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.join(projectRoot, "src");
}

function sqlitePath() {
  return app.isPackaged ? path.join(process.resourcesPath, "sqlite3.exe") : (process.env.CMA_SQLITE3 || "");
}

function safeArgs(values) {
  if (!Array.isArray(values) || values.length > 12) throw new Error("参数数量不正确");
  return values.map((value) => {
    const text = String(value == null ? "" : value);
    if (text.length > 2000 || /[\u0000\r\n]/.test(text)) throw new Error("参数格式不正确");
    return text;
  });
}

function callCli(command, args = [], input = null, timeoutMs = 180000) {
  if (!allowedCommands.has(command)) return Promise.reject(new Error("不允许的操作"));
  const argv = [path.join(runtimeDir(), "product-cli.mjs"), command, ...safeArgs(args)];
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const sqlite = sqlitePath();
    if (sqlite) env.CMA_SQLITE3 = sqlite;
    const child = spawn(process.execPath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const limit = 8 * 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > limit) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > limit) child.kill();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("操作超时，请重试"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
      try {
        const parsed = JSON.parse(line);
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || "命令没有返回有效结果"));
      }
    });
    if (input != null) {
      const body = typeof input === "string" ? input : JSON.stringify(input);
      if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) {
        child.kill();
        clearTimeout(timer);
        reject(new Error("输入数据过大"));
        return;
      }
      child.stdin.end(body);
    } else {
      child.stdin.end();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: "Model Router · Windows Preview",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(here, "index.html"));
}

ipcMain.handle("cma:call", async (_event, request) => {
  const command = String(request && request.command || "");
  const args = request && request.args || [];
  const input = request && request.input != null ? request.input : null;
  return callCli(command, args, input);
});

ipcMain.handle("cma:open-data-dir", async () => {
  const target = path.join(os.homedir(), ".codex", "model-assistant");
  const result = await shell.openPath(target);
  return result ? { ok: false, message: result } : { ok: true };
});

ipcMain.handle("cma:platform", () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  packaged: app.isPackaged
}));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

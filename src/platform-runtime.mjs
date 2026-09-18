import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const isWindows = process.platform === "win32";

function psEscape(value) {
  return String(value ?? "").replaceAll("'", "''");
}

async function powershell(script, options = {}) {
  const candidates = ["powershell.exe", "pwsh.exe"];
  let last;
  for (const executable of candidates) {
    try {
      return await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      last = error;
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw last ?? new Error("找不到 PowerShell");
}

export function normalizeProcessText(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

export function windowsProcessRows(jsonText) {
  const text = String(jsonText ?? "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId ?? row.processId ?? 0),
      command: normalizeProcessText(row.CommandLine || row.ExecutablePath || ""),
      executable: normalizeProcessText(row.ExecutablePath || ""),
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && (row.command || row.executable));
}

export async function processRows() {
  if (!isWindows) {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,args"], { maxBuffer: 8 * 1024 * 1024 });
    return String(stdout).split("\n").map((line) => {
      const pid = Number((line.match(/^\s*(\d+)\s/) || [])[1]);
      return { pid, command: normalizeProcessText(line.replace(/^\s*\d+\s+/, "")), executable: "" };
    }).filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.command);
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,ExecutablePath",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await powershell(script);
  return windowsProcessRows(stdout);
}

export async function processListingText() {
  const rows = await processRows();
  return rows.map((row) => `${row.pid} ${row.command || row.executable}`).join("\n");
}

export async function processCommand(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return "";
  if (!isWindows) {
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(target), "-o", "args="], { maxBuffer: 1024 * 1024 });
      return normalizeProcessText(stdout).trim();
    } catch {
      return "";
    }
  }
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${target}" -ErrorAction SilentlyContinue; if($p){$p.CommandLine}`;
  try {
    const { stdout } = await powershell(script, { maxBuffer: 1024 * 1024 });
    return normalizeProcessText(stdout).trim();
  } catch {
    return "";
  }
}

export async function terminateProcessTree(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) throw new Error("进程号无效");
  if (target === process.pid || target === process.ppid) throw new Error("拒绝结束助手自身进程");
  if (isWindows) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(target), "/T", "/F"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      return;
    } catch (error) {
      const detail = String(error.stderr ?? error.message ?? "");
      if (/not found|no running instance|找不到|不存在/i.test(detail)) return;
      throw error;
    }
  }
  try {
    process.kill(-target, "SIGTERM");
  } catch (error) {
    if (!["ESRCH", "EPERM"].includes(error.code)) throw error;
    process.kill(target, "SIGTERM");
  }
}

export async function activateProcess(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  if (isWindows) {
    const script = `$ws=New-Object -ComObject WScript.Shell; if($ws.AppActivate(${target})){exit 0}else{exit 1}`;
    try { await powershell(script); return true; } catch { return false; }
  }
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${target} to true`]);
    return true;
  } catch {
    return false;
  }
}

export function parseWindowsAppxCandidates(jsonText) {
  const text = String(jsonText ?? "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      name: String(row.Name ?? row.name ?? ""),
      family: String(row.PackageFamilyName ?? row.family ?? ""),
      installLocation: String(row.InstallLocation ?? row.installLocation ?? ""),
      executable: String(row.Executable ?? row.executable ?? ""),
      appId: String(row.AppId ?? row.appId ?? ""),
      displayName: String(row.DisplayName ?? row.displayName ?? ""),
    }))
    .filter((row) => row.installLocation && row.executable);
}

export async function findCodexDesktopExecutable() {
  const override = String(process.env.CMA_CODEX_DESKTOP ?? "").trim();
  if (override) {
    try { await fs.access(override); return override; }
    catch { throw new Error(`CMA_CODEX_DESKTOP 指向的文件不存在：${override}`); }
  }
  if (!isWindows) {
    const mac = "/Applications/Codex.app/Contents/MacOS/ChatGPT";
    try { await fs.access(mac); return mac; } catch {
      throw new Error("没有找到 Codex/ChatGPT 桌面版（需要在 /Applications 下）。请先安装官方桌面版。");
    }
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$out=@()",
    "Get-AppxPackage | Where-Object { $_.Name -match 'ChatGPT|OpenAI|Codex' -or $_.PackageFamilyName -match 'ChatGPT|OpenAI|Codex' } | ForEach-Object {",
    "  $pkg=$_; $manifest=Get-AppxPackageManifest $pkg",
    "  foreach($app in $manifest.Package.Applications.Application){",
    "    if($app.Executable){ $out += [pscustomobject]@{Name=$pkg.Name;PackageFamilyName=$pkg.PackageFamilyName;InstallLocation=$pkg.InstallLocation;Executable=$app.Executable;AppId=$app.Id;DisplayName=$app.VisualElements.DisplayName} }",
    "  }",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("; ");
  let candidates = [];
  try {
    const { stdout } = await powershell(script);
    candidates = parseWindowsAppxCandidates(stdout);
  } catch { }
  const ranked = candidates.slice().sort((a, b) => {
    const score = (row) => /chatgpt|codex/i.test(`${row.name} ${row.family} ${row.executable} ${row.displayName}`) ? 1 : 0;
    return score(b) - score(a);
  });
  for (const row of ranked) {
    const executable = path.join(row.installLocation, row.executable);
    try { await fs.access(executable); return executable; } catch { }
  }
  throw new Error("没有找到 Windows 版 ChatGPT/Codex。请先从 Microsoft Store 安装官方 ChatGPT 桌面应用；也可以用 CMA_CODEX_DESKTOP 指定可执行文件路径。");
}

export async function spawnCodexDesktop(args = [], env = process.env) {
  const executable = await findCodexDesktopExecutable();
  const child = spawn(executable, args, {
    env,
    stdio: "ignore",
    detached: true,
    windowsHide: false,
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child;
}

export async function killGatewayProcesses() {
  if (!isWindows) {
    try { await execFileAsync("/usr/bin/pkill", ["-f", "model-gateway.mjs"]); } catch { }
    return;
  }
  const rows = await processRows().catch(() => []);
  for (const row of rows) {
    if (!row.command.includes("model-gateway.mjs")) continue;
    if (row.pid === process.pid || row.pid === process.ppid) continue;
    try { await terminateProcessTree(row.pid); } catch { }
  }
}

export async function linkSharedAsset(source, destination) {
  const stat = await fs.stat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.lstat(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!isWindows) {
    await fs.symlink(source, destination, stat.isDirectory() ? "dir" : "file");
    return;
  }
  if (stat.isDirectory()) {
    // NTFS junction 不要求 Developer Mode/管理员权限，而且能保持 skills/plugins 实时共享。
    await fs.symlink(path.resolve(source), destination, "junction");
    return;
  }
  // 同一用户目录通常在同一卷，hard link 不需要管理员并保持 auth/hooks 实时同步。
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    // 极少数跨卷/文件系统场景退化为复制；至少保证窗口能启动。
    await fs.copyFile(source, destination);
  }
}

export function runCommandWithInput(executable, args, input = "", { maxBuffer = 32 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { }
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) return fail(new Error("子进程标准输出超过限制"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) return fail(new Error("子进程错误输出超过限制"));
      stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      };
      if (result.code === 0) return resolve(result);
      const error = new Error(result.stderr.trim() || `命令退出：${result.code}`);
      error.code = result.code;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      reject(error);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    child.stdin.end(String(input ?? ""));
  });
}

export function sqliteExecutable() {
  const override = String(process.env.CMA_SQLITE3 ?? "").trim();
  if (override) return override;
  if (isWindows) {
    const resources = String(process.resourcesPath ?? "").trim();
    if (resources) return path.join(resources, "sqlite3.exe");
    return "sqlite3.exe";
  }
  return "/usr/bin/sqlite3";
}

export function tarExecutable() {
  if (isWindows) return "tar.exe";
  return "/usr/bin/tar";
}

export async function platformDiskRoot(target = os.homedir()) {
  if (!isWindows) return "/";
  const parsed = path.parse(path.resolve(target));
  return parsed.root || "C:\\";
}


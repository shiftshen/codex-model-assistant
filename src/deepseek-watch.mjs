// 盯住 api.deepseek.com：这台机器上到底还有哪些进程在连它。
//
// 为什么需要它：配置文件里"换了模型"不等于"没人再调这个端点"。压缩、后备链、
// 以及别的程序（openclaw、Hermes 之类）都可能绕过主模型继续打它，而账单一涨
// 只能看到总数，看不出是谁。用户对扣费最大的疑问就是"到底谁在花我的钱"——
// 这个脚本只做一件事：把"谁在连"如实记下来，不再靠推断。
//
// 采样方式：解析 api.deepseek.com 的 IP，然后周期性看有没有进程跟这些 IP
// 建立了连接。DeepSeek 的请求通常要跑几秒（上下文大），所以轮询抓得住。
//
// 已知局限（别把这个数字当成"调用次数"直接用）：api.deepseek.com 落在
// CloudFront 的共享 IP 上，浏览器打开 deepseek 官网时那条 keep-alive 连接
// 会落进同一个 IP。所以命中要分两类看——"浏览器"那一类是噪声，真正说明
// 问题的是非浏览器进程。要彻底消掉噪声得按 TLS SNI 匹配（需要 tcpdump/root），
// 这里退一步：分开计数，别让噪声淹掉信号。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.join(os.homedir(), ".codex", "model-assistant");
const LOG = path.join(ROOT, "deepseek-calls.jsonl");
const STATE = path.join(ROOT, "deepseek-watch.json");

const SAMPLE_MS = 2000;
// 同一个进程在窗口内重复命中只记一条：一次调用会连续占用好几秒的连接，
// 不去重的话日志会被同一件事刷满，看不出"发生了几次"。
const DEDUPE_MS = 60_000;
const DNS_REFRESH_MS = 5 * 60_000;

const HOST = "api.deepseek.com";

export function classifyProcess(command, name = "") {
  const text = `${command} ${name}`.toLowerCase();
  if (text.includes("model-gateway") || text.includes("model-assistant") || text.includes("codex-model")) return "Codex 模型助手";
  if (text.includes("openclaw")) return "openclaw";
  if (text.includes("hermes")) return "Hermes";
  if (text.includes("chatgpt") || text.includes("/codex.app/")) return "Codex 本体";
  if (/chrome|safari|firefox|arc|edge/.test(text)) return "浏览器";
  return "其他程序";
}

export async function resolveHostIPs(host = HOST) {
  try {
    const { stdout } = await run("dig", ["+short", host], { timeout: 5000 });
    return stdout.split("\n").map((line) => line.trim()).filter((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line));
  } catch {
    return [];
  }
}

export function parseLsofLines(stdout) {
  return stdout.split("\n").slice(1).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    return { name: parts[0] ?? "", pid: Number(parts[1]) || 0 };
  }).filter((entry) => entry.pid > 0);
}

async function establishedTo(ips) {
  if (!ips.length) return [];
  const args = ["-nP", ...ips.map((ip) => `-iTCP@${ip}`), "-sTCP:ESTABLISHED"];
  try {
    const { stdout } = await run("lsof", args, { timeout: 8000, maxBuffer: 4 << 20 });
    return parseLsofLines(stdout);
  } catch (error) {
    // 没有任何匹配时 lsof 会以退出码 1 结束，这是正常情况，不是失败。
    return parseLsofLines(error?.stdout ?? "");
  }
}

async function describeProcess(pid) {
  try {
    const { stdout } = await run("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function appendRecord(record) {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  // 日志按行追加：进程随时可能被杀，逐行落盘才能保证已经抓到的证据不丢。
  await fs.appendFile(LOG, JSON.stringify(record) + "\n");
}

export async function readCallLog(limit = 200) {
  try {
    const text = await fs.readFile(LOG, "utf8");
    return text.split("\n").filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// 监控是后台常驻进程，界面和命令行都要能看出"它还在跑吗、跑了多久"。
export async function readWatchState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE, "utf8"));
    // 进程被杀时来不及写收尾状态，所以用心跳时间判断是不是真的还活着。
    const alive = state.running === true && Date.now() - Date.parse(state.updatedAt ?? 0) < 60_000;
    return { ...state, alive };
  } catch {
    return null;
  }
}

export function summarizeCalls(records) {
  const byKind = new Map();
  for (const record of records) {
    const key = record.kind || "未知";
    const entry = byKind.get(key) ?? { kind: key, count: 0, first: record.at, last: record.at, processes: new Set() };
    entry.count += 1;
    entry.last = record.at;
    if (record.command) entry.processes.add(record.command);
    byKind.set(key, entry);
  }
  return [...byKind.values()]
    .map((entry) => ({ ...entry, processes: [...entry.processes].slice(0, 4) }))
    .sort((a, b) => b.count - a.count);
}

async function writeState(state) {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await fs.writeFile(STATE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

async function main() {
  const hours = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 24;
  const deadline = Date.now() + hours * 3600_000;
  const seen = new Map();
  let ips = await resolveHostIPs();
  let lastDns = Date.now();
  let hits = 0;
  let apiHits = 0;
  let browserHits = 0;
  let samples = 0;

  console.log(`开始监控 ${HOST}（目标 IP: ${ips.join(", ") || "解析失败"}），最长 ${hours} 小时`);
  await writeState({ startedAt: new Date().toISOString(), host: HOST, ips, hours, hits: 0, apiHits: 0, browserHits: 0, samples: 0, running: true });

  while (Date.now() < deadline) {
    if (Date.now() - lastDns > DNS_REFRESH_MS) {
      ips = await resolveHostIPs();
      lastDns = Date.now();
    }
    samples += 1;
    for (const entry of await establishedTo(ips)) {
      const now = Date.now();
      if (seen.get(entry.pid) && now - seen.get(entry.pid) < DEDUPE_MS) continue;
      seen.set(entry.pid, now);
      const command = await describeProcess(entry.pid);
      const record = {
        at: new Date().toISOString(),
        pid: entry.pid,
        command: entry.name,
        full: command,
        kind: classifyProcess(command, entry.name),
        ips,
      };
      await appendRecord(record);
      hits += 1;
      // 浏览器是共享 IP 带来的噪声，单独计数，别混进"谁在调 API"里。
      if (record.kind === "浏览器") browserHits += 1;
      else apiHits += 1;
      console.log(`[${new Date().toLocaleTimeString("zh-CN")}] ${record.kind} ← ${record.command} (pid ${record.pid})`);
    }
    await writeState({ startedAt: new Date().toISOString(), host: HOST, ips, hours, hits, apiHits, browserHits, samples, running: true, updatedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  }
  await writeState({ host: HOST, ips, hours, hits, apiHits, browserHits, samples, running: false, endedAt: new Date().toISOString() });
  console.log(`监控结束：非浏览器命中 ${apiHits} 次，浏览器噪声 ${browserHits} 次`);
}

// 用绝对路径比较：直接 `node src/deepseek-watch.mjs` 时 argv[1] 是相对路径，
// 跟 import.meta.url 永远不相等，主逻辑会静默不执行（踩过）。
const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error("监控异常退出:", error.message);
    process.exit(1);
  });
}

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class ExpertLedger {
  constructor(root, clock = () => Date.now()) {
    this.clock = clock;
    const directory = path.join(root, "expert");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "usage.sqlite");
    this.database = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.database.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, caller TEXT NOT NULL, expert TEXT NOT NULL, model TEXT NOT NULL,
      request_hash TEXT NOT NULL, reason TEXT NOT NULL, created_ms INTEGER NOT NULL,
      status TEXT NOT NULL, input_chars INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
      answer TEXT, input_tokens INTEGER, output_tokens INTEGER, error_code TEXT
    ); CREATE INDEX IF NOT EXISTS calls_created ON calls(created_ms);
    CREATE INDEX IF NOT EXISTS calls_hash ON calls(caller, request_hash, created_ms);`);
  }
  dayStart() { return Math.floor(this.clock() / 86400000) * 86400000; }
  status(caller) {
    const since = this.dayStart();
    const global = this.database.prepare("SELECT count(*) AS calls, coalesce(sum(input_tokens),0) AS inputTokens, coalesce(sum(output_tokens),0) AS outputTokens FROM calls WHERE created_ms >= ?").get(since);
    const own = caller ? this.database.prepare("SELECT count(*) AS calls FROM calls WHERE caller = ? AND created_ms >= ?").get(caller, since).calls : null;
    const records = this.database.prepare("SELECT id, caller, expert, model, reason, created_ms AS createdMs, status, input_chars AS inputChars, input_tokens AS inputTokens, output_tokens AS outputTokens FROM calls ORDER BY created_ms DESC LIMIT 30").all();
    return { ...global, callerCalls: own, resetsAt: new Date(since + 86400000).toISOString(), records };
  }
  reserve({ caller, route, requestHash, reason, inputChars, policy }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock();
      const previous = this.database.prepare("SELECT * FROM calls WHERE caller = ? AND request_hash = ? AND created_ms >= ? ORDER BY created_ms DESC LIMIT 1").get(caller, requestHash, now - 86400000);
      if (previous?.status === "completed") {
        this.database.exec("COMMIT");
        return { cached: true, id: previous.id, answer: previous.answer, inputTokens: previous.input_tokens, outputTokens: previous.output_tokens };
      }
      if (previous?.status === "pending") throw new Error("相同咨询正在进行或结果不确定，不会重复发送计费请求");
      const today = this.status(caller);
      if (today.calls >= policy.dailyCalls) throw new Error("今日专家总额度已用尽，请继续本地处理");
      if (today.callerCalls >= policy.callerDailyCalls) throw new Error("本地主力今日专家额度已用尽，请继续本地处理");
      const last = this.database.prepare("SELECT created_ms FROM calls WHERE caller = ? ORDER BY created_ms DESC LIMIT 1").get(caller);
      if (last && now - last.created_ms < policy.cooldownSeconds * 1000) throw new Error("专家咨询处于冷却期，请先尝试已有建议");
      if (previous && now - previous.created_ms < 300000) throw new Error("该咨询刚刚失败，5 分钟内不重复尝试，防止不确定计费");
      const id = randomUUID();
      this.database.prepare("INSERT INTO calls(id, caller, expert, model, request_hash, reason, created_ms, status, input_chars, max_output_tokens) VALUES(?,?,?,?,?,?,?,'pending',?,?)").run(id, caller, route.id, route.model, requestHash, reason, now, inputChars, policy.maxOutputTokens);
      this.database.exec("COMMIT");
      return { cached: false, id };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  finish(id, answer, usage = {}) {
    this.database.prepare("UPDATE calls SET status='completed', answer=?, input_tokens=?, output_tokens=? WHERE id=? AND status='pending'").run(answer, usage.input_tokens ?? null, usage.output_tokens ?? null, id);
  }
  fail(id, code, usage = {}) {
    this.database.prepare("UPDATE calls SET status='failed', error_code=?, input_tokens=?, output_tokens=? WHERE id=? AND status='pending'").run(code, usage.input_tokens ?? null, usage.output_tokens ?? null, id);
  }
  close() { this.database.close(); }
}

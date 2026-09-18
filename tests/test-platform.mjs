import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { runCommandWithInput } from "../src/platform-runtime.mjs";

export const isWindowsTest = process.platform === "win32";
export const sqliteTestBinary = process.env.CMA_SQLITE3 || (isWindowsTest ? "sqlite3.exe" : "/usr/bin/sqlite3");
export const tarTestBinary = isWindowsTest ? "tar.exe" : "/usr/bin/tar";
export const execFileAsync = promisify(execFile);

export async function sqliteAsync(database, query) {
  return runCommandWithInput(sqliteTestBinary, [database], query, { maxBuffer: 64 * 1024 * 1024 });
}

export function sqliteSync(database, query) {
  return execFileSync(sqliteTestBinary, [database, query], { encoding: "utf8" }).trim();
}

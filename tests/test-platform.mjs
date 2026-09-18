import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

export const isWindowsTest = process.platform === "win32";
export const sqliteTestBinary = process.env.CMA_SQLITE3 || (isWindowsTest ? "sqlite3.exe" : "/usr/bin/sqlite3");
export const tarTestBinary = isWindowsTest ? "tar.exe" : "/usr/bin/tar";
export const execFileAsync = promisify(execFile);

export function sqliteSync(database, query) {
  return execFileSync(sqliteTestBinary, [database, query], { encoding: "utf8" }).trim();
}

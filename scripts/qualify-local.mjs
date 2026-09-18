import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway, gatewayURL } from "../src/model-gateway.mjs";
import { renderProductConfig, catalog } from "../src/product-service.mjs";

const routeID = process.argv[2];
const gameMode = process.argv.includes("--game");
if (!["s5090-ornith", "s5090-qwen"].includes(routeID)) throw new Error("Specify a local route");
const candidateRoot = process.argv.includes("--candidate") ? await fs.mkdtemp(path.join(os.tmpdir(), "cma-candidate-store-")) : null;
const store = new ModelStore(candidateRoot || undefined);
if (candidateRoot) {
  const original = await new ModelStore().route(routeID);
  await store.save({ ...original, archived: false }, (await store.read()).revision);
}
const route = await store.route(routeID);
const directory = path.resolve("output", `qualification-${routeID}-${Date.now()}`);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cma-qualification-"));
const workspace = path.join(temporary, "workspace");
const home = path.join(temporary, "home");
await fs.mkdir(workspace);
await fs.mkdir(home);
const server = createGateway(store);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const catalogPath = path.join(home, "model-catalog.json");
await fs.writeFile(catalogPath, JSON.stringify(catalog(route)));
await fs.writeFile(path.join(home, "config.toml"), renderProductConfig('approval_policy = "never"\n', route, catalogPath).replaceAll(gatewayURL, endpoint));
await fs.writeFile(path.join(workspace, "engine.mjs"), 'export function canMove(board, from, to) { return from[0] === to[0] || from[1] === to[1]; }\n');
await fs.writeFile(path.join(workspace, "README.md"), `Repair engine.mjs, export canMove(board, from, to). Board is 10 rows x 9 columns, entries null or {side:'red'|'black',type:'rook'|'cannon'|'pawn'}. Coordinates [row,column]. Only rook movements initially. Reject out of bounds, empty source, zero distance, own capture, diagonals, blocked paths. Rook can capture enemy with clear path. Do not mutate board. Write and run node tests. No packages or internet required.\n`);
const results = [];
let sessionID;
async function run(stage, prompt, resume = false, compact = false) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never"];
  if (compact) args.push("-c", "model_auto_compact_token_limit=12000");
  if (resume) args.push("resume", sessionID);
  args.push(prompt);
  const child = spawn("/Applications/Codex.app/Contents/Resources/codex", args, { cwd: workspace, env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), CODEX_HOME: home, CMA_ROUTE_TOKEN: await store.token(routeID) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const chunks = [];
  let timedOut = false;
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} }, stage === "full-game" ? 600000 : 180000);
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
  child.stderr.on("data", (chunk) => chunks.push(chunk.toString()));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  const text = chunks.join("");
  await fs.writeFile(path.join(directory, `${stage}.log`), text, { mode: 0o600 });
  const events = text.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  sessionID ||= events.find((event) => event.type === "thread.started")?.thread_id;
  const commands = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
  const result = { stage, code, timedOut, seconds: Math.round((Date.now() - started) / 1000), executedCommands: commands.length, ranTests: commands.some((event) => /node\s+(?:--test|[^\s]*test)|npm\s+test/.test(event.item.command) && event.item.exit_code === 0), answer: events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message").at(-1)?.item.text.slice(-500) || "" };
  results.push(result);
  console.log(JSON.stringify({ routeID, ...result }));
  return result;
}
async function verify(type) {
  const { canMove } = await import(`${pathToFileURL(path.join(workspace, "engine.mjs"))}?stage=${type}&revision=${randomUUID()}`);
  let passed = 0;
  let failed = 0;
  for (let fromRow = 0; fromRow < 10; fromRow++) {
    for (let toRow = 0; toRow < 10; toRow++) {
      for (let toColumn = 0; toColumn < 9; toColumn++) {
        for (let mode = 0; mode < 4; mode++) {
          const board = Array.from({ length: 10 }, () => Array(9).fill(null));
          board[fromRow][4] = { side: "red", type };
          if (mode === 1 && fromRow !== 5) board[5][4] = { side: "black", type: "pawn" };
          if (mode === 2 && !(toRow === fromRow && toColumn === 4)) board[toRow][toColumn] = { side: "black", type: "pawn" };
          if (mode === 3 && !(toRow === fromRow && toColumn === 4)) board[toRow][toColumn] = { side: "red", type: "pawn" };
          let expected = false;
          if (board[fromRow][4]?.type === type && (fromRow !== toRow || toColumn !== 4) && (fromRow === toRow || toColumn === 4) && board[toRow][toColumn]?.side !== "red") {
            const rowStep = Math.sign(toRow - fromRow);
            const columnStep = Math.sign(toColumn - 4);
            let screens = 0;
            for (let row = fromRow + rowStep, column = 4 + columnStep; row !== toRow || column !== toColumn; row += rowStep, column += columnStep) if (board[row][column]) screens++;
            expected = type === "rook" ? screens === 0 : screens === (board[toRow][toColumn] ? 1 : 0);
          }
          const before = JSON.stringify(board);
          try {
            const actual = canMove(board, [fromRow, 4], [toRow, toColumn]);
            if (actual === expected && before === JSON.stringify(board)) passed++; else failed++;
          } catch { failed++; }
        }
      }
    }
  }
  const empty = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [from, to] of [[[0, 0], [0, 1]], [[-1, 0], [0, 0]], [[0, 0], [10, 0]], [[0, 0], [0, 9]]]) {
    try { if (canMove(empty, from, to) === false) passed++; else failed++; } catch { failed++; }
  }
  const result = { stage: `${type}-independent-tests`, passed, failed };
  results.push(result);
  console.log(JSON.stringify({ routeID, ...result }));
  return failed === 0;
}
try {
  if (gameMode) {
    await run("full-game", "Build a complete playable Chinese chess (Xiangqi) local two-player browser game in this workspace. This supersedes the initial rook-only README. Deliver index.html and engine.mjs, no packages/network/assets needed. Use an accessible Chinese UI: 10x9 board, 32 initial pieces, red first, click piece then destination, legal highlights, turn indicator, undo, restart, capture and win detection. All seven piece types must obey Xiangqi rules: horse leg, elephant eye and river, advisor/general palace, cannon screen, pawns crossing river, flying generals, and forbid exposing own king to check. Keep engine independent of DOM. Export initialBoard() (10 rows x9 cols, cells null or {side:'red'|'black',type:'rook'|'cannon'|'pawn'|'horse'|'elephant'|'advisor'|'king'}), canMove(board,from,to) using [row,column], and isInCheck(board,side). Red moves toward decreasing row, red palace rows7..9 cols3..5; black opposite. Keep canMove nonmutating. Write comprehensive automated node tests, actually run them, fix failures. Finish all artifacts instead of stopping at a plan or saying next you will implement. No AI opponent needed. Start and finish the work now.");
  } else {
  let first = await run("rook-repair", "Read README.md and engine.mjs. Fix the rook move validator to satisfy the specification, add automated tests, run them and fix any failures. Complete actual file edits, not a proposal.");
  let correct = !first.timedOut && first.code === 0 && await verify("rook");
  if (!first.timedOut && sessionID && (!correct || !first.ranTests)) {
    first = await run("rook-correction", "Acceptance failed or tests were not actually run. Check empty-source rejection and all requirements in README. Finish the tests, actually execute them with node, repair failures. Do not end with a promise to do the next step.", true);
    correct = !first.timedOut && first.code === 0 && await verify("rook");
  }
  if (correct && first.ranTests) {
    const next = await run("cannon-followup", "Extend the existing engine to support cannon moves without breaking rooks. Cannon moves without capture need a clear orthogonal path. Cannon captures an enemy only with exactly one intervening piece. Keep all previous bounds/own-capture/no-mutation checks. Add and run tests and fix failures.", true);
    if (!next.timedOut && next.code === 0 && next.ranTests && await verify("rook") && await verify("cannon")) {
      const markers = [randomUUID(), randomUUID()];
      await Promise.all(markers.map((marker, index) => fs.writeFile(path.join(workspace, `marker-${index}.txt`), marker)));
      const dual = await Promise.all(markers.map((marker, index) => run(`dual-${index}`, `Use a shell command to read marker-${index}.txt. Reply exactly with its contents. Do not modify files.`)));
      results.push({ stage: "dual-task-isolation", passed: dual.every((result, index) => result.code === 0 && !result.timedOut && result.executedCommands > 0 && result.answer.trim() === markers[index]) });
      const compacted = await run("compact-resume", "Continue the existing engine task. Run the existing tests using the terminal and report the test result. Do not rewrite the engine or stop after saying you will inspect it.", true, true);
      let compactEvents = 0;
      async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await scan(file);
          else if (entry.name.endsWith(".jsonl")) {
            const text = await fs.readFile(file, "utf8");
            compactEvents += text.split("\n").filter((line) => { try { return JSON.parse(line).type === "compacted"; } catch { return false; } }).length;
          }
        }
      }
      await scan(path.join(home, "sessions"));
      results.push({ stage: "compact-continuation", passed: compacted.code === 0 && !compacted.timedOut && compacted.ranTests && compactEvents > 0 && compactEvents <= 2, compactEvents });
    }
  }
  }
} catch (error) {
  results.push({ stage: "harness-error", error: error.message });
} finally {
  await fs.cp(workspace, path.join(directory, "workspace"), { recursive: true });
  const qualified = gameMode ? null : results.some((result) => result.stage === "dual-task-isolation" && result.passed === true) && results.some((result) => result.stage === "compact-continuation" && result.passed === true);
  process.exitCode = gameMode ? (results[0]?.code === 0 && !results[0]?.timedOut ? 0 : 1) : qualified ? 0 : 1;
  await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({ routeID, model: route.model, qualified, results, note: "Prerequisite gate only; passing is not commercial certification." }, null, 2));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
  if (candidateRoot) await fs.rm(candidateRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ directory }));
}

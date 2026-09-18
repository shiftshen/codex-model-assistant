import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const engine = await import(pathToFileURL(path.resolve(process.argv[2])));
const results = [];
const piece = (side, type) => ({ side, type });
function board(cells = []) {
  const value = Array.from({ length: 10 }, () => Array(9).fill(null));
  value[9][4] = piece("red", "king");
  value[0][3] = piece("black", "king");
  for (const [row, column, side, type] of cells) value[row][column] = piece(side, type);
  return value;
}
function check(name, operation) {
  try { operation(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function move(name, cells, from, to, expected) {
  check(name, () => {
    const value = board(cells);
    const before = JSON.stringify(value);
    assert.equal(engine.canMove(value, from, to), expected);
    assert.equal(JSON.stringify(value), before, "mutated board");
  });
}
check("initial board has 32 pieces and 16 per side", () => {
  const value = engine.initialBoard();
  assert.equal(value.length, 10);
  assert.ok(value.every((row) => row.length === 9));
  assert.equal(value.flat().filter(Boolean).length, 32);
  for (const side of ["red", "black"]) assert.equal(value.flat().filter((cell) => cell?.side === side).length, 16);
  assert.equal(value[9][4].type, "king");
  assert.equal(value[0][4].type, "king");
  assert.equal(engine.isInCheck(value, "red"), false);
  assert.equal(engine.isInCheck(value, "black"), false);
});
move("empty source", [], [6, 0], [5, 0], false);
move("out of bounds", [], [9, 4], [10, 4], false);
move("horse leg clear", [[7, 4, "red", "horse"]], [7, 4], [5, 5], true);
move("horse leg blocked", [[7, 4, "red", "horse"], [6, 4, "red", "pawn"]], [7, 4], [5, 5], false);
move("elephant eye clear", [[9, 2, "red", "elephant"]], [9, 2], [7, 4], true);
move("elephant eye blocked", [[9, 2, "red", "elephant"], [8, 3, "red", "pawn"]], [9, 2], [7, 4], false);
move("elephant cannot cross river", [[5, 2, "red", "elephant"]], [5, 2], [3, 4], false);
move("advisor diagonal inside palace", [[9, 3, "red", "advisor"]], [9, 3], [8, 4], true);
move("advisor outside palace", [[8, 3, "red", "advisor"]], [8, 3], [7, 2], false);
move("king one step", [], [9, 4], [8, 4], true);
move("king cannot jump", [], [9, 4], [7, 4], false);
move("pawn forward", [[6, 0, "red", "pawn"]], [6, 0], [5, 0], true);
move("pawn before river cannot move sideways", [[6, 0, "red", "pawn"]], [6, 0], [6, 1], false);
move("pawn after river sideways", [[4, 0, "red", "pawn"]], [4, 0], [4, 1], true);
move("pawn cannot retreat", [[4, 0, "red", "pawn"]], [4, 0], [5, 0], false);
move("black pawn direction", [[3, 0, "black", "pawn"]], [3, 0], [4, 0], true);
move("cannon capture needs screen", [[7, 0, "red", "cannon"], [3, 0, "black", "rook"]], [7, 0], [3, 0], false);
move("cannon one screen", [[7, 0, "red", "cannon"], [5, 0, "red", "pawn"], [3, 0, "black", "rook"]], [7, 0], [3, 0], true);
move("cannon two screens", [[7, 0, "red", "cannon"], [5, 0, "red", "pawn"], [4, 0, "black", "pawn"], [3, 0, "black", "rook"]], [7, 0], [3, 0], false);
move("pinned rook cannot expose king", [[7, 4, "red", "rook"], [4, 4, "black", "rook"]], [7, 4], [7, 5], false);
check("flying generals are check", () => {
  const value = board(); value[0][3] = null; value[0][4] = piece("black", "king");
  assert.equal(engine.isInCheck(value, "red"), true);
  assert.equal(engine.isInCheck(value, "black"), true);
});
check("cannot uncover facing generals", () => {
  const value = board([[5, 4, "red", "rook"]]); value[0][3] = null; value[0][4] = piece("black", "king");
  assert.equal(engine.canMove(value, [5, 4], [5, 5]), false);
});
check("cannon check requires exactly one screen", () => {
  assert.equal(engine.isInCheck(board([[4, 4, "black", "cannon"]]), "red"), false);
  assert.equal(engine.isInCheck(board([[4, 4, "black", "cannon"], [7, 4, "red", "pawn"]]), "red"), true);
});
console.log(JSON.stringify({ passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results }, null, 2));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;

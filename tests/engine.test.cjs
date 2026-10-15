const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual embedded source without adding test hooks to the shipped page.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function section(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `source section: ${from}`);
  return html.slice(start, end);
}
let seed = 0x12345678;
const math = Object.create(Math);
math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const context = vm.createContext({ Math: math });
vm.runInContext(section('const DIFFS =', 'const PALETTES =') +
  section('const ROW =', '/* ---------- 状态 ---------- */') +
  section('function freshStats()', 'let stats =') +
  section('function validState(x)', "const saved =") +
  ';globalThis.api = { search, generate, validGrid, validState, normalizeStats, DIFFS };', context);
const { search, generate, validGrid, validState, normalizeStats, DIFFS } = context.api;
const plain = x => JSON.parse(JSON.stringify(x));
function checkSolution(grid) {
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let n = 0; n < 9; n++) {
    const row = [], col = [], box = [];
    for (let k = 0; k < 9; k++) {
      row.push(grid[n * 9 + k]); col.push(grid[k * 9 + n]);
      box.push(grid[(Math.floor(n / 3) * 3 + Math.floor(k / 3)) * 9 + n % 3 * 3 + k % 3]);
    }
    for (const unit of [row, col, box]) assert.deepEqual(unit.sort(), expected);
  }
}

for (const diff of Object.keys(DIFFS)) {
  test(`${diff}: generated puzzles have one valid solution and preserve their givens`, () => {
    for (let n = 0; n < 20; n++) {
      const { puzzle, solution } = generate(diff);
      checkSolution(solution);
      const before = plain(puzzle);
      const result = search(puzzle, 2, false);
      assert.equal(result.count, 1);
      assert.deepEqual(plain(result.solution), plain(solution));
      assert.deepEqual(plain(puzzle), before, 'search must not mutate its input');
      assert.ok(puzzle.filter(Boolean).length >= DIFFS[diff].clues);
      assert.ok(puzzle.filter(Boolean).length < 81);
      assert.ok(puzzle.every((v, i) => !v || v === solution[i]));
    }
  });
}

test('search rejects malformed or conflicting grids and stops at the solution limit', () => {
  for (const invalid of [null, [], Array(81), Array(81).fill(10), Array(81).fill(-1), Array(81).fill('0')]) {
    assert.equal(search(invalid, 2, false).count, 0);
  }
  for (const other of [1, 9, 10]) {
    const duplicate = Array(81).fill(0); duplicate[0] = duplicate[other] = 5;
    assert.equal(search(duplicate, 2, false).count, 0);
  }
  assert.equal(search(Array(81).fill(0), 2, false).count, 2);
  assert.equal(validGrid(Array(81), 9), false);
});

test('saved games reject inconsistent givens, nonunique puzzles and invalid note masks', () => {
  const g = generate('easy');
  const saved = { ...g, diff: 'easy', values: g.puzzle.slice(), notes: Array(81).fill(0) };
  assert.equal(validState(saved), true);
  const empty = saved.puzzle.indexOf(0), given = saved.puzzle.findIndex(Boolean);
  for (const mutate of [
    s => { s.diff = '__proto__'; },
    s => { s.solution[0] = 0; },
    s => { s.values[given] = 0; },
    s => { s.notes[empty] = 1; },
    s => { s.notes[given] = 2; },
    s => { s.notes[empty] = 1024; },
    s => { s.puzzle = Array(81).fill(0); },
    s => { s.puzzle[given] = s.puzzle[given] % 9 + 1; }
  ]) {
    const bad = plain(saved); mutate(bad); assert.equal(validState(bad), false);
  }
  const wrong = plain(saved); wrong.values[empty] = wrong.solution[empty] % 9 + 1;
  assert.equal(validState(wrong), true, 'mistakes are valid resumable progress');
});

test('statistics normalization rejects unsafe and nonnumeric data', () => {
  const stats = normalizeStats({ easy: { won: -1, best: '0' }, medium: { won: 3, best: 0 },
    hard: { won: Infinity, best: Number.MAX_SAFE_INTEGER + 1 }, expert: null });
  assert.deepEqual(plain(stats.easy), { won: 0, best: null });
  assert.deepEqual(plain(stats.medium), { won: 3, best: 0 });
  assert.deepEqual(plain(stats.hard), { won: 0, best: null });
});

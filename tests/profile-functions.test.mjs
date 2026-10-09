import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree } from '../src/lib/call-tree.ts';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { selectProfileFunctions } from '../src/lib/profile-functions.ts';

const node = (id, name, children = [], url = 'src/app.ts', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

/** Samples one millisecond apart, so a sample is a millisecond of wall time. */
const profile = (nodes, samples) => ({
  nodes, samples,
  timeDeltas: samples.map(() => 1000),
  startTime: 0,
  endTime: samples.length * 1000,
});

const classes = ruleClassTable();

const functionsFor = (nodes, samples) =>
  selectProfileFunctions(buildCallTree(profile(nodes, samples), samples.length, {}), classes, samples.length);

/**
 * A screen component that delegates everything, under React's scheduler, plus
 * an unrelated leaf that does all its own work.
 */
const nodes = [
  node(0, '(root)', [1, 5], ''),
  node(1, 'performWorkOnRoot', [2], 'node_modules/react-dom/index.js'),
  node(2, 'Search_Search', [3], 'src/screens/Search.tsx', 11),
  node(3, 'applyMerge', [4], 'src/screens/merge.ts', 4),
  node(4, 'toLocaleString', [], 'native date.js'),
  node(5, 'writeCache', [], 'src/cache.ts', 7),
];

test('a function that delegates all its work still gets a row', () => {
  // The session roll-up these figures could have come from drops any frame
  // that was never itself the sampled leaf. That is precisely the wrong frame
  // to drop: a component whose cost is entirely in what it calls has no self
  // time at all, and is what a reader came to find. On one local trace that
  // filter hid `Search_Search` at 1086 ms, `Search_SearchTypeMenuWide` at
  // 325 ms and `useSearchTypeMenuSections` at 302 ms.
  const { functions } = functionsFor(nodes, [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5]);
  const search = functions.find((fn) => fn.name === 'Search_Search');
  assert.ok(search, 'Search_Search is missing');
  assert.equal(search.selfMs, 0);
  assert.equal(search.totalMs, 10);
});

test('the ranking is by inclusive time, so a wrapper outranks a busier leaf', () => {
  // `writeCache` did four milliseconds of its own work and `Search_Search`
  // none, and the one worth opening first is still `Search_Search`.
  const { functions } = functionsFor(nodes, [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5]);
  assert.deepEqual(functions.map((fn) => fn.name), ['applyMerge', 'Search_Search', 'writeCache']);
  assert.deepEqual(functions.map((fn) => fn.totalMs), [10, 10, 4]);
});

test('framework and engine frames are left out of the ranking', () => {
  // `performWorkOnRoot` is on the stack for every render in the recording, so
  // without this it tops the list for being React rather than for being slow.
  // `toLocaleString` is the engine, which a reader cannot open either.
  const { functions } = functionsFor(nodes, [4, 4, 4, 4, 5]);
  const names = functions.map((fn) => fn.name);
  assert.ok(!names.includes('performWorkOnRoot'), 'React internals leaked into the ranking');
  assert.ok(!names.includes('toLocaleString'), 'an engine frame leaked into the ranking');
});

test('idle is absence of work, not a function anyone can open', () => {
  const withIdle = [...nodes, node(6, '(idle)', [], '')];
  const { functions } = functionsFor(withIdle, [6, 6, 6, 6, 6, 5, 5]);
  assert.deepEqual(functions.map((fn) => fn.name), ['writeCache']);
});

test('a recursive descent is counted once, not once per level', () => {
  // `walk` calling `walk` is one call of the whole subtree. Summing each
  // level's inclusive time would report a six-deep descent at six times its
  // cost, and put it above work that really did run longer.
  const recursive = [
    node(0, '(root)', [1], ''),
    node(1, 'walk', [2], 'src/walk.ts', 1),
    node(2, 'walk', [3], 'src/walk.ts', 1),
    node(3, 'walk', [], 'src/walk.ts', 1),
  ];
  const { functions } = functionsFor(recursive, [3, 3, 3, 3, 3, 3, 3, 3]);
  const walk = functions.find((fn) => fn.name === 'walk');
  assert.equal(walk.totalMs, 8);
  assert.equal(walk.selfMs, 8);
});

test('the share is of the whole recording, and the tail is counted not listed', () => {
  // 160 distinct functions, each cheaper than the last, against a cut of 150.
  const many = [node(0, '(root)', [], '')];
  const samples = [];
  for (let index = 1; index <= 160; index += 1) {
    many[0].children.push(index);
    many.push(node(index, `work${String(index).padStart(3, '0')}`, [], `src/w${index}.ts`, 1));
    for (let count = 0; count < 161 - index; count += 1) samples.push(index);
  }
  const set = functionsFor(many, samples);
  assert.equal(set.functions.length, 150);
  assert.equal(set.omittedCount, 10);
  assert.equal(set.durationMs, samples.length);
  assert.equal(set.functions[0].name, 'work001');
  assert.equal(set.functions[0].totalPercent, Math.round((160 / samples.length) * 1000) / 10);
});

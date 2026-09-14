import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBottlenecks } from '../src/lib/bottlenecks.ts';
import { clientHotspots, normalizeHotspots } from '../src/lib/analysis.ts';

const node = (id, name, children = [], url = 'app.js') => ({ id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: 0, columnNumber: 0 } });
const profile = (nodes, samples) => ({ nodes, samples, startTime: 0, endTime: 100000 });

test('separate bursts of the same dispatch caller remain separate umbrellas', () => {
  const nodes = [
    node(0, '(root)', [1, 4, 5], ''), node(1, 'dispatchEvent', [2, 3]),
    node(2, 'formatDate'), node(3, 'compare'), node(4, '(idle)', [], ''), node(5, 'otherWork'),
  ];
  for (const boundary of [0, 4, 5, 999]) {
    const groups = groupBottlenecks(profile(nodes, [2, 2, 3, boundary, 3, 3, 2]), 210);
    const dispatches = groups.filter(g => g.title === 'dispatchEvent');
    assert.equal(dispatches.length, 2);
    assert.deepEqual(dispatches.map(g => g.combinedTimeMs), [90, 90]);
    assert.deepEqual(dispatches.map(g => g.functions.map(f => [f.title, f.selfTimeMs])), [
      [['formatDate', 60], ['compare', 30]], [['compare', 60], ['formatDate', 30]],
    ]);
    assert.equal(new Set(dispatches.flatMap(g => [g.id, ...g.functions.map(f => f.id)])).size, 6);
    assert.equal(normalizeHotspots([], 210, groups).hotspots.filter(g => g.groupingCaller === 'dispatchEvent').length, 2);
  }
});

test('identical caller source locations on different nodes do not merge', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1, 3], ''), node(1, 'dispatchEvent', [2]), node(2, 'helper'),
    node(3, 'dispatchEvent', [4]), node(4, 'helper'),
  ], [2, 4]), 60);
  assert.deepEqual(groups.map(g => [g.title, g.combinedTimeMs]), [['dispatchEvent', 30], ['dispatchEvent', 30]]);
});

test('nested work and GC interruptions stay in one caller run', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1, 4], ''), node(1, 'dispatchEvent', [2, 3]),
    node(2, 'formatDate'), node(3, 'compare'), node(4, '(garbage collector)', [], ''),
  ], [2, 3, 4, 2, 3]), 150);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].combinedTimeMs, 120);
  assert.deepEqual(groups[0].functions.map(f => f.selfTimeMs), [60, 60]);
});

test('hotspot threshold applies independently to each occurrence', () => {
  assert.deepEqual(groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent'),
  ], [1, 0, 1]), 60), []);
});

test('nested functions share an umbrella and combined self time determines rank', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1, 4], ''), node(1, 'render', [2]), node(2, 'sort', [3]), node(3, 'compare'), node(4, 'animate'),
  ], [1, 2, 2, 3, 3, 3, 4, 4, 4, 0]), 100);
  assert.deepEqual(groups.map(g => [g.title, g.combinedTimeMs]), [['render', 60], ['animate', 30]]);
  assert.deepEqual(groups[0].functions.map(f => [f.title, f.selfTimeMs]), [['compare', 30]]);
  assert.equal(groups[0].percentOfTotal, 60);
  assert.equal(groups[0].functions[0].stack.length, 3);
});

test('shared helpers remain attributed to their own caller, including zero-self callers', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1, 3], ''), node(1, 'search', [2]), node(2, 'helper'), node(3, 'save', [4]), node(4, 'helper'),
  ], [2, 2, 2, 4]), 100);
  assert.deepEqual(groups.map(g => [g.title, g.combinedTimeMs]), [['search', 75], ['save', 25]]);
});

test('dispatch wrappers do not combine separate work; recursion does not double count', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'processTicksAndRejections', [2, 4]), node(2, 'search', [3]), node(3, 'search'), node(4, 'save'),
  ], [2, 3, 4]), 90);
  assert.deepEqual(groups.map(g => [g.title, g.combinedTimeMs]), [['search', 60], ['save', 30]]);
  assert.equal(groups[0].functions.length, 1);
});

test('parentId profiles and malformed cycles terminate safely; empty profiles have no groups', () => {
  const a = { ...node(1, 'entry'), parentId: 2 };
  const b = { ...node(2, 'child'), parentId: 1 };
  assert.equal(groupBottlenecks(profile([a, b], [2]), 100)[0].combinedTimeMs, 100);
  assert.deepEqual(groupBottlenecks(profile([], []), 0), []);
});

test('uses CPU-profile time deltas instead of treating unequal intervals as equal samples', () => {
  const weighted = {
    ...profile([
      node(0, '(root)', [1], ''), node(1, 'dispatchEvent', [2, 3]),
      node(2, 'briefWork'), node(3, 'expensiveWork'),
    ], [2, 3]),
    timeDeltas: [10_000, 90_000],
  };
  const groups = groupBottlenecks(weighted, 100);
  assert.equal(groups[0].combinedTimeMs, 100);
  assert.deepEqual(groups[0].functions.map(fn => [fn.title, fn.selfTimeMs]), [
    ['expensiveWork', 90],
  ]);
});

test('agent cannot alter measured times, omit groups, or duplicate cards', () => {
  const groups = groupBottlenecks(profile([node(1, 'entry')], [1]), 100);
  const { hotspots } = normalizeHotspots([
    { id: groups[0].id, title: 'Expensive work', supportingFunctionIds: [groups[0].functions[0].id], summary: 'Measured work', combinedTimeMs: 999 },
    { id: groups[0].id, summary: 'Duplicate' }, { id: 'invented' },
  ], 100, groups);
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].combinedTimeMs, 100);
  assert.deepEqual(hotspots[0].summary, ['Measured work']);
  assert.equal(normalizeHotspots([], 100, groups).hotspots.length, 1);
});


test('descriptive annotations replace wrapper titles without changing measured traces', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent', [2]),
    node(2, 'batchedUpdates', [3, 6]), node(3, 'formatDate', [4, 5]),
    node(4, 'Intl.DateTimeFormat.prototype.format'), node(5, 'Intl.DateTimeFormat'),
    node(6, 'Array.prototype.sort', [7]), node(7, 'String.prototype.localeCompare'),
  ], [4, 4, 4, 4, 5, 7, 7]), 700);
  const group = groups[0];
  const result = normalizeHotspots([{
    id: group.id, title: 'Expensive date formatting and locale-aware sorting',
    summary: ['Date formatting dominates, with additional sorting and formatter construction costs.'],
    supportingFunctionIds: group.functions.map(fn => fn.id),
    functions: [], percentOfTotal: 999,
  }], 700, groups).hotspots[0];
  assert.equal(group.title, 'dispatchEvent');
  assert.equal(result.title, 'Expensive date formatting and locale-aware sorting');
  assert.equal(result.groupingCaller, 'dispatchEvent');
  assert.equal(result.combinedTimeMs, 700);
  assert.equal(result.percentOfTotal, 100);
  assert.deepEqual(result.functions, group.functions);
  assert.deepEqual(result.supportingFunctionIds, group.functions.map(fn => fn.id));
});

test('missing, foreign, or incomplete evidence falls back to measured work', () => {
  const groups = groupBottlenecks(profile([
    node(1, 'dispatchEvent', [2, 3]), node(2, 'formatDate'), node(3, 'compare'),
  ], [2, 2, 3]), 90);
  const group = groups[0];
  for (const ids of [undefined, [], ['invented'], [group.functions[0].id, 'foreign'], [group.functions[1].id]]) {
    const result = normalizeHotspots([{
      id: group.id, title: 'Unsupported title', summary: 'Unsupported summary',
      supportingFunctionIds: ids,
    }], 90, groups).hotspots[0];
    assert.equal(result.title, 'formatDate / compare');
    assert.match(result.summary.join(' '), /formatDate \(60 ms self time\)/);
    assert.equal(result.combinedTimeMs, 90);
  }
});


test('summary annotations become at most three bullets', () => {
  const groups = groupBottlenecks(profile([node(1, 'formatDate')], [1]), 100);
  const { hotspots } = normalizeHotspots([{
    id: groups[0].id,
    title: 'Expensive date formatting',
    supportingFunctionIds: [groups[0].functions[0].id],
    summary: ['First', 'Second', 'Third', 'Fourth'],
  }], 100, groups);
  assert.deepEqual(hotspots[0].summary, ['First', 'Second', 'Third']);
  assert.deepEqual(normalizeHotspots([{
    id: groups[0].id,
    title: 'Expensive date formatting',
    supportingFunctionIds: [groups[0].functions[0].id],
    summary: 'Date formatting dominates. Sorting adds cost. Formatter construction is extra.',
  }], 100, groups).hotspots[0].summary, [
    'Date formatting dominates.',
    'Sorting adds cost.',
    'Formatter construction is extra.',
  ]);
});

test('invalid descriptive titles fall back together with their explanations', () => {
  const groups = groupBottlenecks(profile([node(1, 'formatDate')], [1]), 100);
  for (const title of [undefined, '', '   ', 'x'.repeat(121), 42]) {
    const result = normalizeHotspots([{
      id: groups[0].id, title, summary: 'Unusable explanation',
      supportingFunctionIds: [groups[0].functions[0].id],
    }], 100, groups).hotspots[0];
    assert.equal(result.title, 'formatDate');
    assert.doesNotMatch(result.summary.join(' '), /Unusable/);
  }
});

test('client hotspots keep card function names and omit stacks', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent', [2, 3, 4, 5]),
    node(2, 'one'), node(3, 'two'), node(4, 'three'), node(5, 'four'),
  ], [2, 3, 4, 5]), 120);
  const stored = normalizeHotspots([], 120, groups).hotspots[0];
  const published = clientHotspots([stored])[0];
  assert.ok(stored.functions.length > 3);
  assert.ok(stored.functions.some((fn) => fn.stack.length > 0));
  assert.equal(published.functions.length, 3);
  assert.deepEqual(published.functions.map((fn) => fn.title), stored.functions.slice(0, 3).map((fn) => fn.title));
  assert.ok(published.functions.every((fn) => fn.stack.length === 0));
  assert.deepEqual(published.stack, []);
});

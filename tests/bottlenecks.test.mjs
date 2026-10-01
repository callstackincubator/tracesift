import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBottlenecks } from '../src/lib/bottlenecks.ts';
import { clientHotspots, normalizeFunctionEvidence, normalizeHotspots } from '../src/lib/analysis.ts';

const node = (id, name, children = [], url = 'app.js') => ({ id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: 0, columnNumber: 0 } });
const profile = (nodes, samples) => ({ nodes, samples, startTime: 0, endTime: 100000 });

test('separate bursts of the same caller combine into one umbrella that counts them', () => {
  const nodes = [
    node(0, '(root)', [1, 4, 5], ''), node(1, 'dispatchEvent', [2, 3]),
    node(2, 'formatDate'), node(3, 'compare'), node(4, '(idle)', [], ''), node(5, 'otherWork'),
  ];
  for (const boundary of [0, 4, 5, 999]) {
    const groups = groupBottlenecks(profile(nodes, [2, 2, 3, boundary, 3, 3, 2]), 210);
    const dispatches = groups.filter(g => g.title === 'dispatchEvent');
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].combinedTimeMs, 180);
    // The per-run partition still drives attribution; only the reporting combines.
    assert.deepEqual(dispatches[0].functions.map(f => [f.title, f.selfTimeMs]), [['formatDate', 90], ['compare', 90]]);
    assert.equal(dispatches[0].occurrences, 2);
    assert.equal(dispatches[0].longestRunMs, 90);
    assert.equal(normalizeHotspots([], 210, groups).hotspots.filter(g => g.groupingCaller === 'dispatchEvent').length, 1);
  }
});

test('the same caller reached by different call paths is one bottleneck', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1, 3], ''), node(1, 'dispatchEvent', [2]), node(2, 'helper'),
    node(3, 'dispatchEvent', [4]), node(4, 'helper'),
  ], [2, 4]), 60);
  // Contiguous samples in one function are one burst, whichever node they came from.
  assert.deepEqual(groups.map(g => [g.title, g.combinedTimeMs, g.occurrences]), [['dispatchEvent', 60, 1]]);
});

test('render work is attributed to the component, not React\'s scheduler', () => {
  // The real shape of a React render stack: the outermost named frame is always
  // the scheduler, so grouping on it collapsed every component into one card.
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''),
    node(1, 'processRootScheduleInMicrotask', [2]), node(2, 'performWorkOnRoot', [3]),
    node(3, 'workLoopSync', [4]), node(4, 'beginWork', [5]),
    node(5, 'updateFunctionComponent', [6]), node(6, 'renderWithHooks', [7]),
    node(7, 'SearchResults', [8, 9]), node(8, 'getReportSections'), node(9, 'buildIndex'),
  ], [8, 8, 8, 9, 9]), 100);
  assert.deepEqual(groups.map(g => g.title), ['SearchResults']);
  assert.deepEqual(groups[0].functions.map(f => [f.title, f.selfTimeMs]), [['getReportSections', 60], ['buildIndex', 40]]);
});

test('a stack with no application frame still groups, then drops as framework-only', () => {
  // Nothing to promote: the fallback keeps the group well-formed so the
  // frameworkOnly rule is what removes it, rather than it vanishing silently.
  assert.deepEqual(groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'performWorkOnRoot', [2]),
    node(2, 'beginWork', [3]), node(3, 'reconcileChildFibersImpl'),
  ], [3, 3, 3]), 100), []);
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

test('a caller whose bursts never add up to a meaningful share earns no card', () => {
  // 1000 samples over 10 s is 10 ms each, so three scattered bursts total 30 ms:
  // past the absolute floor, nowhere near worth a card against a 10 s profile.
  const samples = Array.from({ length: 1000 }, (_, index) => (index % 400 === 0 ? 1 : 0));
  assert.deepEqual(groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent'),
  ], samples), 10000), []);
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
    { id: groups[0].id, title: 'Expensive work', functions: [{ id: groups[0].functions[0].id, evidence: 'Measured work' }], combinedTimeMs: 999 },
    { id: groups[0].id, functions: [{ id: groups[0].functions[0].id, evidence: 'Duplicate' }] }, { id: 'invented' },
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
    functions: group.functions.slice(0, 3).map(fn => ({ id: fn.id, evidence: `${fn.title} costs measured time.` })),
    percentOfTotal: 999,
  }], 700, groups).hotspots[0];
  assert.equal(group.title, 'dispatchEvent');
  assert.equal(result.title, 'Expensive date formatting and locale-aware sorting');
  assert.equal(result.groupingCaller, 'dispatchEvent');
  assert.equal(result.combinedTimeMs, 700);
  assert.equal(result.percentOfTotal, 100);
  assert.deepEqual(result.functions, group.functions);
  assert.deepEqual(result.supportingFunctionIds, group.functions.slice(0, 3).map(fn => fn.id));
});

test('missing, foreign, or incomplete evidence falls back to measured work', () => {
  const groups = groupBottlenecks(profile([
    node(1, 'dispatchEvent', [2, 3]), node(2, 'formatDate'), node(3, 'compare'),
  ], [2, 2, 3]), 90);
  const group = groups[0];
  for (const cited of [
    undefined, [], [{ id: 'invented', evidence: 'x' }],
    [{ id: group.functions[0].id, evidence: 'x' }, { id: 'foreign', evidence: 'y' }],
    [{ id: group.functions[1].id, evidence: 'x' }],
    [{ id: group.functions[0].id }],
  ]) {
    const result = normalizeHotspots([{
      id: group.id, title: 'Unsupported title', functions: cited,
    }], 90, groups).hotspots[0];
    assert.equal(result.title, 'formatDate / compare');
    assert.match(result.summary.join(' '), /formatDate \(60 ms self time\)/);
    assert.equal(result.combinedTimeMs, 90);
  }
});


test('evidence stays attached to the function it was written about', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent', [2, 3, 4]),
    node(2, 'formatDate'), node(3, 'compare'), node(4, 'sort'),
  ], [2, 2, 3, 4]), 120);
  const [formatDate, compare, sort] = groups[0].functions;
  assert.equal(formatDate.title, 'formatDate');
  // Cited out of measured order, and one entry over the cap.
  const { hotspots } = normalizeHotspots([{
    id: groups[0].id,
    title: 'Expensive date formatting',
    functions: [
      { id: sort.id, evidence: 'about sort' },
      { id: formatDate.id, evidence: 'about formatDate' },
      { id: compare.id, evidence: 'about compare' },
      { id: 'b1-f99', evidence: 'about nothing' },
    ],
  }], 120, groups);
  assert.equal(hotspots[0].evidence[formatDate.id], 'about formatDate');
  assert.equal(hotspots[0].evidence[sort.id], 'about sort');
  assert.equal(hotspots[0].evidence['b1-f99'], undefined);
  // Flattened in measured order, not the order the agent happened to cite.
  assert.deepEqual(hotspots[0].summary, ['about formatDate', 'about compare', 'about sort']);
});

test('a single-function group gets exactly one piece of evidence', () => {
  const groups = groupBottlenecks(profile([node(1, 'formatDate')], [1]), 100);
  const { hotspots } = normalizeHotspots([{
    id: groups[0].id,
    title: 'Expensive date formatting',
    functions: [{ id: groups[0].functions[0].id, evidence: 'First' }],
  }], 100, groups);
  assert.deepEqual(hotspots[0].summary, ['First']);
});

test('invalid descriptive titles fall back while long titles are normalized locally', () => {
  const groups = groupBottlenecks(profile([node(1, 'formatDate')], [1]), 100);
  for (const title of [undefined, '', '   ', 42]) {
    const result = normalizeHotspots([{
      id: groups[0].id, title,
      functions: [{ id: groups[0].functions[0].id, evidence: 'Unusable explanation' }],
    }], 100, groups).hotspots[0];
    assert.equal(result.title, 'formatDate');
    assert.doesNotMatch(result.summary.join(' '), /Unusable/);
  }
  const normalized = normalizeHotspots([{
    id: groups[0].id, title: 'x'.repeat(240),
    functions: [{ id: groups[0].functions[0].id, evidence: 'Usable explanation' }],
  }], 100, groups).hotspots[0];
  assert.equal(normalized.title, 'x'.repeat(120));
  assert.deepEqual(normalized.summary, ['Usable explanation']);
});

test('evidence survives a full sentence and trims on a word boundary', () => {
  const evidence = 'getReportSections records 104.94 ms self time, or 14% of the group; the '
    + 'representative stack places it inside getSections under Search_Search, reached from '
    + 'the Todo search results provider.';
  assert.deepEqual(normalizeFunctionEvidence([{ id: 'b1-f1', evidence }]), [{ id: 'b1-f1', evidence }]);

  const [{ evidence: trimmed }] = normalizeFunctionEvidence([{ id: 'b1-f1', evidence: 'word '.repeat(400) }]);
  assert.ok(trimmed.length < 'word '.repeat(400).length);
  assert.ok(trimmed.endsWith('word…'), `trimmed mid-word: ${trimmed.slice(-12)}`);
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

test('published hotspots carry the measured totals the card needs to split unlisted from unnamed time', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'dispatchEvent', [2, 3, 4, 5]),
    node(2, 'one'), node(3, 'two'), node(4, 'three'), node(5, 'four'),
  ], [2, 3, 4, 5]), 120);
  const published = clientHotspots(normalizeHotspots([], 120, groups).hotspots)[0];
  const shownMs = published.functions.reduce((sum, fn) => sum + fn.selfTimeMs, 0);
  assert.equal(published.namedFunctionCount, 4);
  assert.ok(published.namedTimeMs > shownMs, 'the fourth function is measured but not published');
  // Without namedTimeMs the card would bill that fourth function as unnamed time.
  assert.ok(published.combinedTimeMs - published.namedTimeMs < published.combinedTimeMs - shownMs);
});

test("React 19's commit flush steps are recognized as framework internals", () => {
  for (const name of ['flushMutationEffects', 'flushLayoutEffects', 'flushSpawnedWork', 'flushPendingEffects']) {
    assert.deepEqual(groupBottlenecks(profile([
      node(0, '(root)', [1], ''), node(1, 'performWorkOnRoot', [2]), node(2, name),
    ], [2, 2]), 60), [], `${name} should not reach the report`);
  }
});

test('groups made only of React internals are dropped before ranking', () => {
  const nodes = [
    node(0, '(root)', [1, 4], ''),
    node(1, 'scheduleRender', [2, 3]), node(2, 'reconcileChildFibersImpl'), node(3, 'commitMutationEffects'),
    node(4, 'renderList', [5]), node(5, 'formatDate'),
  ];
  const groups = groupBottlenecks(profile(nodes, [2, 2, 3, 3, 5]), 150);
  assert.deepEqual(groups.map(g => g.title), ['renderList']);
  assert.deepEqual(groups[0].functions.map(f => f.title), ['formatDate']);
});

test('finely sampled profiles name functions the group threshold would have discarded', () => {
  // 4000 samples at 0.25 ms: a 5 ms function is 20 real samples, not jitter, but
  // sits far below the 20 ms a group needs to earn a card.
  const nodes = [node(0, '(root)', [1], ''), node(1, 'handleTap', [2, 3])];
  nodes.push(node(2, 'bigWork'), node(3, 'smallButRealWork'));
  const samples = [];
  for (let i = 0; i < 4000; i++) samples.push(i % 100 === 0 ? 3 : 2);
  const groups = groupBottlenecks(profile(nodes, samples), 1000);
  assert.deepEqual(groups[0].functions.map(f => f.title), ['bigWork', 'smallButRealWork']);
  const named = groups[0].functions.reduce((sum, fn) => sum + fn.selfTimeMs, 0);
  assert.ok(named > groups[0].combinedTimeMs * 0.99, 'both functions are attributed');
});

test('a group where React internals dominate is dropped even beside minor application work', () => {
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'performWorkOnRoot', [2, 3]),
    node(2, 'commitMutationEffectsOnFiber'), node(3, 'tinyAppHelper'),
  ];
  const samples = [];
  for (let i = 0; i < 1000; i++) samples.push(i % 50 === 0 ? 3 : 2);
  // tinyAppHelper is 2% of the group; the internals explain nothing actionable.
  assert.deepEqual(groupBottlenecks(profile(nodes, samples), 500), []);
});

test('internal frames stay inside a group that also holds application work', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'renderList', [2, 3]),
    node(2, 'beginWork'), node(3, 'formatDate'),
  ], [2, 2, 3, 3]), 120);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].frameworkOnly, false);
  assert.deepEqual(groups[0].functions.map(f => f.title).sort(), ['beginWork', 'formatDate']);
});

test('React internals are recognized by dev-build names and renderer module paths', () => {
  const rendererUrl = 'node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js';
  for (const leaf of [node(2, 'beginWork$1'), node(2, 'appendChild', [], rendererUrl)]) {
    assert.deepEqual(groupBottlenecks(profile([
      node(0, '(root)', [1], ''), node(1, 'performWorkUntilDeadline', [2]), leaf,
    ], [2, 2]), 60), []);
  }
});

test('hot functions carry a readable source location and omit bundle and native frames', () => {
  const groups = groupBottlenecks(profile([
    node(0, '(root)', [1], ''), node(1, 'render', [2, 3, 4]),
    { ...node(2, 'formatDate', [], 'src/explore.tsx'), callFrame: { functionName: 'formatDate', scriptId: '1', url: 'src/explore.tsx', lineNumber: 41, columnNumber: 6 } },
    node(3, 'parseJSON', [], 'http://localhost:8081/index.bundle'),
    node(4, 'nativeSort', [], '(native)'),
  ], [2, 2, 3, 3, 4, 4]), 180);
  const located = Object.fromEntries(groups[0].functions.map(fn => [fn.title, fn.location]));
  assert.deepEqual(located, { formatDate: 'src/explore.tsx:42:7', parseJSON: undefined, nativeSort: undefined });
  const published = clientHotspots(normalizeHotspots([], 180, groups).hotspots)[0];
  assert.equal(published.functions.find(fn => fn.title === 'formatDate').location, 'src/explore.tsx:42:7');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree } from '../src/lib/call-tree.ts';
import { selectCards } from '../src/lib/profile-cards.ts';
import { frameNameTier } from '../src/lib/frame-names.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});
const frame = (name, url = 'app.js') => ({ functionName: name, scriptId: '1', url, lineNumber: 0, columnNumber: 0 });

/**
 * Real profiles carry thousands of samples and more than one branch of work,
 * and both facts matter: the floors scale with the sampling interval, and a
 * subtree owning the whole recording is deliberately split rather than becoming
 * one card. `DENSITY` supplies the first, the background branch the second —
 * each written sample keeps its weight, so the millisecond figures in a fixture
 * are exactly the ones asserted.
 */
const DENSITY = 60;
const BACKGROUND = 900;

function cardsFor(nodes, samples, subjectMs, { background = true, ...options } = {}) {
  const dense = Array.from({ length: DENSITY }, () => samples).flat();
  if (!background) return selectCards(buildCallTree({ nodes, samples: dense, startTime: 0, endTime: 1 }, subjectMs, options));
  const withBackground = nodes.map((entry) => entry.id === 0 ? { ...entry, children: [...entry.children, BACKGROUND] } : entry);
  withBackground.push(node(BACKGROUND, 'backgroundWork', [], 'bg.js'));
  const padded = [...dense, ...dense.map(() => BACKGROUND)];
  return selectCards(buildCallTree({ nodes: withBackground, samples: padded, startTime: 0, endTime: 1 }, subjectMs * 2, options));
}

/** The fixture's own background branch is scaffolding, not a finding. */
const subjectTitles = (cards) => cards.map((card) => card.title).filter((title) => title !== 'backgroundWork').sort();

test('names that explain nothing can never title a card', () => {
  for (const name of ['', '(anonymous)', 'Function call', '(program)', '(garbage collector)', 'eval', 'workLoop']) {
    assert.equal(frameNameTier(frame(name)), 0, name);
  }
  // Framework internals and minified names are demoted rather than listed
  // above: they are real identifiers, just never ones a card can be headed by.
  assert.equal(frameNameTier(frame('beginWork')), 1);
  assert.equal(frameNameTier(frame('t')), 1);
  assert.equal(frameNameTier(frame('getReportSections')), 2);
});

test('a frame doing substantial work in its own body is where the descent stops', () => {
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'handlePress', [2]), node(2, 'computeTotals', [3]), node(3, 'helper'),
  ], [2, 2, 2, 3], 400);
  const card = cards.find((entry) => entry.title === 'computeTotals');
  assert.ok(card, `expected a computeTotals card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.totalMs, 400);
  assert.equal(card.selfMs, 300);
});

test('a pass-through is walked past, and its name is carried to a nameless callee', () => {
  // `Function call` and the anonymous frames below it are real stack entries
  // and useless titles; `renderRow` is the last thing a developer wrote.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'renderRow', [2]), node(2, 'Function call', [3]),
    node(3, '', [4]), node(4, '', []),
  ], [4, 4, 4, 4], 400);
  const card = cards.find((entry) => entry.title === 'renderRow');
  assert.ok(card, `expected a renderRow card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.nameInherited, true);
});

test('a named fork becomes one card whose highlights explain the split', () => {
  // The shape from the brief: a parent with small self time and several
  // significant callees is the grouping point, not something to descend past.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'getSections', [2, 3, 4]),
    node(2, 'getReportSections'), node(3, 'isEmptyObject'), node(4, 'buildIndex'),
  ], [1, 2, 2, 2, 2, 2, 2, 3, 3, 4], 1000);
  const card = cards.find((entry) => entry.title === 'getSections');
  assert.ok(card, `expected a getSections card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.headline, 'getSections at app.js:1:1 spent 1000 ms in total time');
  assert.deepEqual(card.highlights.map((highlight) => highlight.text), [
    'getReportSections - 600ms total time, 600ms self time',
    'isEmptyObject - 200ms total time, 200ms self time',
    'buildIndex - 100ms total time, 100ms self time',
  ]);
});

test('a fork under an untitleable frame splits into one card per branch', () => {
  // Each branch stands alone. Heading them with the skipped parent lost which
  // branch each number belonged to, which is the whole point of the split.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'dispatch', [2]), node(2, 'Function call', [3, 4]),
    node(3, 'parseRows'), node(4, 'sortRows'),
  ], [3, 3, 3, 3, 3, 4, 4, 4, 4, 4], 1000);
  assert.deepEqual(subjectTitles(cards), ['parseRows', 'sortRows']);
});

test('a named frame owning most of the recording splits instead of becoming one card', () => {
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'main', [2, 3]), node(2, 'alpha'), node(3, 'beta'),
  ], [2, 2, 2, 2, 2, 3, 3, 3, 3, 3], 1000, { background: false });
  assert.deepEqual(cards.map((card) => card.title).sort(), ['alpha', 'beta']);
});

test('a frame whose callees are all dust is reported as a long tail, not a slow body', () => {
  // Sixty cells of 20 ms each: every one of them is below the floor, so the
  // parent is all that is left to name.
  const cells = Array.from({ length: 60 }, (_, index) => index + 2);
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'renderList', cells), ...cells.map((id) => node(id, `cell${id}`)),
  ], cells, 1200);
  const card = cards.find((entry) => entry.title === 'renderList');
  assert.ok(card, `expected a renderList card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.selfShape, 'longTail');
});

test('garbage collection is charged to the frame that caused it', () => {
  // Without this the allocator looks like a pure delegator and the descent
  // walks into `(garbage collector)`, which names nothing.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'buildFormatter', [2]), node(2, '(garbage collector)', [], ''),
  ], [1, 2, 2, 2], 400);
  const card = cards.find((entry) => entry.title === 'buildFormatter');
  assert.ok(card, `expected a buildFormatter card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.selfMs, 400);
});

test('framework internals never title a card, nor head one', () => {
  // `beginWork spent 145 ms` reports that React ran. The components below it
  // are the finding, one card each.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'beginWork', [2, 3]),
    node(2, 'SearchResults', [4]), node(3, 'ResultRow', [5]),
    node(4, 'buildIndex'), node(5, 'formatCell'),
  ], [2, 2, 4, 4, 4, 3, 3, 5, 5, 5], 1000);
  assert.deepEqual(subjectTitles(cards), ['ResultRow', 'SearchResults']);
});

test('a framework internal whose whole branch is unnamed yields no card at all', () => {
  // The old fallback titled this `commitHookEffectListMount`; nothing under it
  // names application code, so there is nothing to report.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'commitHookEffectListMount', [2]),
    node(2, 'commitLayoutEffectOnFiber', [3]), node(3, '(anonymous)', [], ''),
  ], [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 1000);
  assert.deepEqual(subjectTitles(cards), []);
});

test('repeated work under a parent is rolled up with its callers', () => {
  const { cards, callCountIsExact } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'buildReport', [2, 3]),
    node(2, 'getTotal', [4]), node(3, 'renderRow', [5]),
    node(4, 'format', [], 'fmt.js'), node(5, 'format', [], 'fmt.js'),
  ], [4, 4, 4, 4, 4, 4, 5, 5, 5, 5], 1000);
  assert.equal(callCountIsExact, false);
  const report = cards.find((card) => card.title === 'buildReport');
  const format = report.repeated.find((entry) => entry.name === 'format');
  // The same helper reached by two different callers is one finding.
  assert.equal(format.callSites, 2);
  assert.equal(format.totalMs, 1000);
  assert.deepEqual(format.callers.map((caller) => [caller.name, caller.totalMs]), [['getTotal', 600], ['renderRow', 400]]);
});

test('recursion is credited to the outermost occurrence only', () => {
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'walk', [2]), node(2, 'visit', [3]),
    node(3, 'walk', [4]), node(4, 'visit', []),
  ], [1, 1, 1, 1, 1, 2, 3, 4, 4, 4], 1000);
  const walk = cards.find((card) => card.title === 'walk');
  assert.equal(walk.totalMs, 1000);
  const visit = walk.repeated.find((entry) => entry.name === 'visit');
  assert.equal(visit.callSites, 2);
  // The outer `visit` holds 500 ms and the inner one 300 ms of that same 500.
  // Crediting both would report more inclusive time than exists.
  assert.equal(visit.totalMs, 500);
});

test('invocation counts are only claimed when the profiler actually records them', () => {
  // Hermes emits one node per invocation; merging them is what makes the count
  // real. V8 nodes are path-unique, so the same shape means only "call sites".
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'render', [2, 3, 4]),
    node(2, 'format', [], 'f.js'), node(3, 'format', [], 'f.js'), node(4, 'layout'),
  ];
  const samples = [2, 2, 2, 3, 3, 3, 4, 4, 4, 4];
  const sampled = cardsFor(nodes, samples, 1000);
  const repeatedIn = (selection) => selection.cards.find((card) => card.title === 'render').repeated.find((entry) => entry.name === 'format');
  assert.equal(repeatedIn(sampled).invocations, undefined);
  const exact = cardsFor(nodes, samples, 1000, { callCountIsExact: true });
  assert.equal(exact.callCountIsExact, true);
  assert.equal(repeatedIn(exact).invocations, 2);
});

test('the callees past the per-level cap survive as a count rather than vanishing', () => {
  const leaves = Array.from({ length: 9 }, (_, index) => index + 20);
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''),
    node(1, 'top', [2, 3]), node(2, 'midA', [4, 5]), node(3, 'midB'),
    node(4, 'deepA', leaves), node(5, 'deepB'),
    ...leaves.map((id) => node(id, `leaf${id}`)),
  ], [1, 3, 5, ...leaves, ...leaves], 2100);
  const top = cards.find((card) => card.title === 'top');
  const deepest = top.children.find((child) => child.name === 'midA').children.find((child) => child.name === 'deepA').children;
  assert.ok(deepest.length <= 7, `level 3 held ${deepest.length} rows`);
  assert.ok(deepest.some((child) => child.truncated), 'the callees past the cap should survive as a count');
});

test('children are captured eight levels deep and no further', () => {
  const chain = Array.from({ length: 12 }, (_, index) => index + 2);
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'top', [2]),
    ...chain.map((id) => node(id, `d${id}`, id === chain[chain.length - 1] ? [] : [id + 1])),
  ], [1, 1, 1, ...Array.from({ length: 7 }, () => 13)], 1000);
  const top = cards.find((card) => card.title === 'top');
  assert.ok(top, `expected a top card, got ${cards.map((entry) => entry.title)}`);
  const depth = (children, level = 0) => children.length === 0 ? level : Math.max(...children.map((child) => depth(child.children, level + 1)));
  assert.equal(depth(top.children), 8);
});

test('the same output comes back from the same profile, twice', () => {
  const nodes = [
    node(0, '(root)', [1], ''), node(1, 'app', [2, 3]), node(2, 'alpha', [4]), node(3, 'beta'),
    node(4, 'shared', [], 's.js'),
  ];
  const run = () => JSON.stringify(cardsFor(nodes, [4, 4, 4, 3, 3, 2], 600));
  assert.equal(run(), run());
});

test('a profile with no samples yields no cards rather than throwing', () => {
  assert.deepEqual(cardsFor([node(0, '(root)', [], '')], [], 0, { background: false }).cards, []);
});

test('a chain of pass-throughs is highlighted at its deepest frame, not its wrapper', () => {
  // `sortUsers` and its comparator both carry nearly all of the subtree, so
  // listing all three says one thing three times. The useful one is the frame
  // that actually spends the time.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'loadProfile', [2, 6]),
    node(2, 'sortUsers', [3]), node(3, 'compareUsers', [4]), node(4, 'toLocaleString', [], 'native'),
    node(6, 'parseResponse'),
  ], [1, 4, 4, 4, 4, 4, 4, 4, 6, 6], 1000);
  const card = cards.find((entry) => entry.title === 'loadProfile');
  assert.ok(card, `expected a loadProfile card, got ${cards.map((entry) => entry.title)}`);
  const names = card.highlights.map((highlight) => highlight.name);
  assert.ok(names.includes('toLocaleString'), `the hot leaf should survive, got ${names}`);
  assert.ok(!names.includes('compareUsers'), `the wrapper should not restate it, got ${names}`);
  assert.ok(names.includes('parseResponse'), `a disjoint branch is its own finding, got ${names}`);
});

test('a card titled by an inherited name does not borrow another function\'s source position', () => {
  // The frame here is a minified `t`; the name on the card came from its
  // caller, so pointing at `t`'s position would send a reader to the wrong code.
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'submitOrder', [2], 'checkout.js', 20),
    node(2, 't', [3], 'vendor.js', 900), node(3, 't', [], 'vendor.js', 950),
  ], [3, 3, 3, 3], 400);
  const card = cards.find((entry) => entry.title === 'submitOrder');
  assert.ok(card, `expected an inherited submitOrder card, got ${cards.map((entry) => entry.title)}`);
  assert.equal(card.nameInherited, true);
  assert.equal(card.location, undefined);
  assert.ok(!card.headline.includes('vendor.js'), card.headline);
});

test('a branch holding no application code is dropped rather than reported', () => {
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'performWorkOnRoot', [2]),
    node(2, 'beginWork', [3]), node(3, 'reconcileChildFibersImpl'),
  ], [3, 3, 3, 3], 400);
  assert.deepEqual(cards.map((card) => card.title), ['backgroundWork']);
});

test('a framework frame keeps its own real name over one inherited from a caller', () => {
  // `reconcileChildrenArray` is searchable; a caller's name pasted onto it is
  // a worse answer to "which function is this".
  const { cards } = cardsFor([
    node(0, '(root)', [1], ''), node(1, 'ProductList', [2, 4], 'list.js', 7),
    node(2, 'reconcileChildrenArray', [3]), node(3, 'formatPrice', [], 'price.js'),
    node(4, 'buildRows'),
  ], [3, 3, 3, 4, 4, 4], 600);
  assert.ok(!cards.some((card) => card.title === 'reconcileChildrenArray' && card.nameInherited));
});

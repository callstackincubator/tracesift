import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { CULPRIT_MIN_MS, focusedTree, selectTaskCards } from '../src/lib/task-cards.ts';
import { attachMeasuredTasks, extractTasks } from '../src/lib/tasks.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

/** Samples one millisecond apart, the first landing one interval after `startTime`. */
const profile = (nodes, samples, startTime = 0) => ({
  nodes, samples,
  timeDeltas: samples.map(() => 1000),
  startTime,
  endTime: startTime + samples.length * 1000,
});

const classes = ruleClassTable();

/**
 * A React-shaped stack: the scheduler hands off to a screen component, which
 * calls a helper, which calls a built-in. Only `Search_Search` and `applyMerge`
 * carry a path a developer could open, so only they classify as `app`.
 */
const nodes = [
  node(0, '(root)', [1], ''),
  node(1, 'performWorkOnRoot', [2], 'node_modules/react-dom/index.js'),
  node(2, 'Search_Search', [3], 'src/screens/Search.tsx', 11),
  node(3, 'applyMerge', [4], 'src/screens/merge.ts', 4),
  node(4, 'toLocaleString', [], 'native date.js'),
  node(5, '(idle)', [], ''),
];

/** 200 samples inside one measured 200 ms task. */
const busy = Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 3 : 4));
const oneTask = attachMeasuredTasks(profile(nodes, busy), [{ ts: 1000, dur: 200_000 }]);

function cardsFor(raw, durationMs, table = classes) {
  return selectTaskCards(raw, durationMs, extractTasks(raw), table);
}

test('a card is one task, with a wall-clock start offset and a measured duration', () => {
  const { cards, boundaries, noLongTasks } = cardsFor(oneTask, 400);
  assert.equal(cards.length, 1);
  assert.equal(boundaries, 'measured');
  assert.equal(noLongTasks, false);
  assert.equal(cards[0].id, 'task-0');
  assert.equal(cards[0].startMs, 1);
  assert.equal(cards[0].durationMs, 200);
  // The heading names the application frame the task entered, because a page
  // of headings that differ only by their numbers says nothing about which to open.
  assert.equal(cards[0].headline, 'Search_Search — a 200 ms task 1 ms into the recording');
  assert.equal(cards[0].percentOfProfile, 50);
});

test('an inferred boundary is never worded as a measured one', () => {
  const inferred = profile(nodes, [...busy, 5, 5, ...busy]);
  const { cards, boundaries } = cardsFor(inferred, 402);
  assert.equal(boundaries, 'inferred');
  assert.ok(cards.every((card) => card.boundaries === 'inferred'));
  assert.match(cards[0].headline, /about \d+ ms of uninterrupted work /);
  assert.ok(!cards.some((card) => / a \d+ ms task/.test(card.headline)));
});

test('the task shares add up rather than claiming the same millisecond twice', () => {
  const two = attachMeasuredTasks(profile(nodes, [...busy, ...busy]), [
    { ts: 1000, dur: 200_000 },
    { ts: 201_000, dur: 200_000 },
  ]);
  const { cards } = cardsFor(two, 400);
  assert.equal(cards.length, 2);
  const share = cards.reduce((sum, card) => sum + card.percentOfProfile, 0);
  assert.ok(share <= 100.5, `shares summed to ${share}`);
});

test('a boundary frame is found in a bundle, where nothing classifies as app', () => {
  // The real case this exists for: a webpack build whose chunks are all hashed,
  // so every rule falls through and the whole task comes back `library`.
  // Requiring `app` left the card with no caption at all; requiring only a name
  // a developer can read gives it the screen component.
  const bundled = [
    node(0, '(root)', [1], ''),
    node(1, 'beginWork', [2], 'main-4f2c.bundle.js'),
    node(2, 'Search_Search', [3], 'main-4f2c.bundle.js'),
    node(3, 'toLocaleString', [], 'native date.js'),
  ];
  const raw = attachMeasuredTasks(
    profile(bundled, Array.from({ length: 200 }, () => 3)),
    [{ ts: 1000, dur: 200_000 }],
  );
  const [card] = cardsFor(raw, 400).cards;
  assert.equal(card.boundaryFrames[0].frameClass ?? 'library', 'library');
  assert.deepEqual(card.boundaryFrames.map((entry) => entry.name), ['Search_Search']);
  assert.match(card.headline, /^Search_Search — /);
});

test('a mangled identifier is walked through rather than made the caption', () => {
  // `t` is a real frame and it is drawn on the chart, but a card headed by it
  // tells a reader strictly less than the frame underneath.
  const mangled = [
    node(0, '(root)', [1], ''),
    node(1, 't', [2], 'main-4f2c.bundle.js'),
    node(2, 'SearchResults', [], 'main-4f2c.bundle.js'),
  ];
  const raw = attachMeasuredTasks(
    profile(mangled, Array.from({ length: 200 }, () => 2)),
    [{ ts: 1000, dur: 200_000 }],
  );
  const [card] = cardsFor(raw, 400).cards;
  assert.deepEqual(card.boundaryFrames.map((entry) => entry.name), ['SearchResults']);
});

test('the boundary frame is the outermost app frame, not the frame doing the work', () => {
  // `Search_Search` delegates every millisecond downward, which is exactly why
  // the old self-ratio descent walked past it. It is still the feature name.
  const [card] = cardsFor(oneTask, 400).cards;
  assert.deepEqual(card.boundaryFrames.map((entry) => entry.name), ['Search_Search']);
  assert.equal(card.boundaryFrames[0].location, 'src/screens/Search.tsx:12:1');
});

test('culprits are ranked by self time and carry their invocation shape', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const [first] = card.culprits;
  assert.equal(first.name, 'toLocaleString');
  assert.equal(first.frameClass, 'native');
  // 180 of the 200 samples landed in the built-in, in 20 separate runs.
  assert.equal(first.invocations, 20);
  assert.match(first.shapeText, /^ran 20 times in this task · 180 ms total · longest single call 9 ms$/);
  // Self time is a partition of the task: nothing overlaps, so it cannot exceed it.
  const self = card.culprits.reduce((sum, culprit) => sum + culprit.selfMs, 0);
  assert.ok(self <= card.durationMs + 0.5, `culprit self time summed to ${self}`);
});

test('a frame that delegated its time is a culprit too, on its inclusive figure', () => {
  // `Search_Search` burns nothing in its own body and holds the whole 200 ms
  // through its callees. A self-time floor cut it, which hid the frame a reader
  // scanning the table is most likely to recognise.
  const [card] = cardsFor(oneTask, 400).cards;
  const delegating = card.culprits.find((culprit) => culprit.name === 'Search_Search');
  assert.ok(delegating, 'a frame holding the task through its callees must get a row');
  assert.ok(delegating.selfMs < CULPRIT_MIN_MS);
  assert.ok(delegating.totalMs >= CULPRIT_MIN_MS);
  // Self time still orders the table, so the frame that burned it stays on top.
  assert.equal(card.culprits[0].name, 'toLocaleString');
});

test('a frame under the floor on both figures is left to the footnote', () => {
  // Two samples of the leaf inside a 200 ms task: 2 ms either way, which is
  // nothing a reader can act on however long the block around it was.
  const thin = [
    node(0, '(root)', [1], ''),
    node(1, 'Search_Search', [2, 3], 'src/screens/Search.tsx', 11),
    node(2, 'applyMerge', [], 'src/screens/merge.ts', 4),
    node(3, 'tick', [], 'src/screens/tick.ts', 2),
  ];
  const samples = Array.from({ length: 200 }, (_, index) => (index < 2 ? 3 : 2));
  const raw = attachMeasuredTasks(profile(thin, samples), [{ ts: 1000, dur: 200_000 }]);
  const [card] = cardsFor(raw, 400).cards;
  assert.deepEqual(card.culprits.map((culprit) => culprit.name), ['applyMerge', 'Search_Search']);
});

test('a culprit carries the named callers that reached it, outermost first', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const [first] = card.culprits;
  // `toLocaleString` on its own says nothing about what to change. The frames
  // above it place it in a feature — and `performWorkOnRoot` is not among them,
  // because the reader did not call the reconciler.
  assert.equal(first.name, 'toLocaleString');
  assert.deepEqual(first.callers, ['Search_Search', 'applyMerge']);
});

test('the caller line stays short enough to read on a row', () => {
  // Eight product frames above the leaf, where `reachedVia` would carry all of
  // them with their URLs for the hand-off.
  const deep = [
    node(0, '(root)', [1], ''),
    ...Array.from({ length: 8 }, (_, index) => node(index + 1, `frame${index}`, [index + 2], 'src/deep.ts', index)),
    node(9, 'toLocaleString', [], 'native date.js'),
  ];
  const raw = attachMeasuredTasks(
    profile(deep, Array.from({ length: 200 }, () => 9)),
    [{ ts: 1000, dur: 200_000 }],
  );
  const [card] = cardsFor(raw, 400).cards;
  const [first] = card.culprits;
  assert.deepEqual(first.callers, ['frame5', 'frame6', 'frame7']);
  assert.ok(first.reachedVia.length > first.callers.length);
});

test('no long task in the recording still returns the busiest work, flagged', () => {
  // Ten 10 ms tasks: every one is under the 50 ms long-task definition, and a
  // blank screen here reads as a broken tool rather than as a finding.
  const short = Array.from({ length: 10 }, (_, index) => ({ ts: 1000 + index * 20_000, dur: 10_000 }));
  const raw = attachMeasuredTasks(profile(nodes, Array.from({ length: 200 }, () => 4)), short);
  const { cards, noLongTasks } = cardsFor(raw, 400);
  assert.equal(noLongTasks, true);
  assert.ok(cards.length > 0, 'the analysis must not come back empty');
});

test('the whole task subtree ships, with no depth or breadth truncation', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const depth = (entry) => entry.children.length === 0 ? 1 : 1 + Math.max(...entry.children.map(depth));
  // (root) → performWorkOnRoot → Search_Search → applyMerge → toLocaleString.
  assert.equal(depth(card.tree), 5);
  assert.equal(card.tree.children[0].frameClass, 'framework');
});

test('an over-long task is broken into segments by the descent, scoped to that task', () => {
  const long = attachMeasuredTasks(
    profile(nodes, Array.from({ length: 2000 }, (_, index) => (index % 10 === 0 ? 3 : 4))),
    [{ ts: 1000, dur: 2_000_000 }],
  );
  const [card] = cardsFor(long, 4000).cards;
  assert.ok(card.durationMs >= 1000);
  assert.ok(Array.isArray(card.segments) && card.segments.length > 0, 'a 2 s task is a phase, not one piece of work');
  // A 200 ms task is a single piece of work and gets no segments at all.
  assert.equal(cardsFor(oneTask, 400).cards[0].segments, undefined);
});

test('the same profile yields the same cards, twice', () => {
  const run = () => JSON.stringify(cardsFor(oneTask, 400));
  assert.equal(run(), run());
});

test('the focused tree drops the framework and lifts the product frame to the top', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const full = card.tree.children;
  assert.deepEqual(full.map((child) => child.name), ['performWorkOnRoot']);
  // The reconciler and the built-in go; the two frames a reader can open stay.
  const focused = focusedTree(card.tree);
  assert.deepEqual(focused.children.map((child) => child.name), ['Search_Search']);
  assert.deepEqual(focused.children[0].children.map((child) => child.name), ['applyMerge']);
  assert.equal(focused.children[0].children[0].children.length, 0);
});

test('time burned by a dropped frame is charged to the nearest frame kept above it', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const focused = focusedTree(card.tree);
  const merge = focused.children[0].children[0];
  // `toLocaleString` held 180 ms of the task in its own body and is gone, so
  // `applyMerge` — the frame that delegated to it — now carries it.
  assert.ok(merge.selfMs >= 180, `applyMerge kept ${merge.selfMs} ms of self time`);
  // A parent still accounts for its own time plus its children's, so the
  // figures on this view add up the way they do on the full tree.
  const total = (entry) => entry.selfMs + entry.children.reduce((sum, child) => sum + total(child), 0);
  assert.ok(Math.abs(total(focused) - focused.totalMs) <= 0.5, `${total(focused)} against ${focused.totalMs}`);
});

test('the focused tree keeps the frame the view is focused on, whatever it is', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const framework = card.tree.children[0];
  assert.equal(framework.frameClass, 'framework');
  const focused = focusedTree(framework);
  assert.equal(focused.name, 'performWorkOnRoot');
  assert.deepEqual(focused.children.map((child) => child.name), ['Search_Search']);
});

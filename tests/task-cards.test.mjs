import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { CULPRIT_MIN_MS, focusedTree, pathlineFor, selectTaskCards, shapelineFor } from '../src/lib/task-cards.ts';
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
  // The reconciler goes. The built-in stays: it names itself, so it is the one
  // kind of engine frame a reader acts on — and it is where the time went.
  const focused = focusedTree(card.tree);
  assert.deepEqual(focused.children.map((child) => child.name), ['Search_Search']);
  assert.deepEqual(focused.children[0].children.map((child) => child.name), ['applyMerge']);
  assert.deepEqual(
    focused.children[0].children[0].children.map((child) => [child.name, child.frameClass]),
    [['toLocaleString', 'native']],
  );
});

test('an engine frame that names nothing is dropped from the focused tree', () => {
  // The exception is the name, not the class. `(garbage collector)` is charged
  // to the frame that triggered it elsewhere, so the unnameable case to test
  // here is a mangled built-in: a real frame whose name says nothing.
  const mangled = [
    node(0, '(root)', [1], ''),
    node(1, 'Search_Search', [2], 'src/screens/Search.tsx', 11),
    node(2, 'Ci', [], 'native array.js'),
  ];
  const raw = attachMeasuredTasks(
    profile(mangled, Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 1 : 2))),
    [{ ts: 1000, dur: 200_000 }],
  );
  const [card] = cardsFor(raw, 400).cards;
  const focused = focusedTree(card.tree);
  const [search] = focused.children;
  assert.equal(search.name, 'Search_Search');
  assert.deepEqual(search.children, []);
  // Dropped, so its time travels up to the frame that delegated into it.
  assert.ok(search.selfMs >= 180, `Search_Search kept ${search.selfMs} ms of self time`);
});

test('time burned by a dropped frame is charged to the nearest frame kept above it', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const focused = focusedTree(card.tree);
  const merge = focused.children[0].children[0];
  // `performWorkOnRoot` is gone and `Search_Search` carries what it burned, so
  // the reconciler's own cost is not lost. `toLocaleString`'s 180 ms stays on
  // `toLocaleString`, which is the point of keeping it.
  assert.ok(merge.selfMs < 180, `applyMerge kept ${merge.selfMs} ms of self time`);
  assert.ok(merge.children[0].selfMs >= 180, `toLocaleString kept ${merge.children[0].selfMs} ms`);
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

test('a boundary frame carries what burned the time inside it, by self time', () => {
  const [card] = cardsFor(oneTask, 400).cards;
  const [feature] = card.boundaryFrames;
  // `Search_Search` spends none of its own 200 ms; the drill-down is the answer
  // to the question its own figure cannot give.
  assert.equal(feature.selfMs, 0);
  assert.deepEqual(
    feature.culprits.map((entry) => [entry.name, entry.selfMs]),
    [['toLocaleString', 180], ['applyMerge', 20]],
  );
  // Self time over a subtree sums to that subtree's inclusive total, so the
  // drill-down is a partition of the slice it opened.
  assert.equal(feature.culprits.reduce((sum, entry) => sum + entry.selfMs, 0), feature.totalMs);
  // Counted inside the frame rather than across the task, and worded that way.
  assert.match(feature.culprits[0].shapeText, /inside this frame/);
});

test('a helper called from two features is split between them, not counted twice', () => {
  // `formatDate` runs under both screens. As a task culprit it is one finding
  // of 120 ms; inside each feature it is only the part that feature caused,
  // because a slice has to be a share of the frame it was drawn in.
  const shared = [
    node(0, '(root)', [1], ''),
    node(1, 'performWorkOnRoot', [2, 5], 'node_modules/react-dom/index.js'),
    node(2, 'Search_Search', [3], 'src/screens/Search.tsx', 11),
    node(3, 'formatDate', [4], 'src/lib/format.ts', 7),
    node(4, 'toLocaleString', [], 'native date.js'),
    node(5, 'Reports_Reports', [6], 'src/screens/Reports.tsx', 3),
    node(6, 'formatDate', [7], 'src/lib/format.ts', 7),
    node(7, 'toLocaleString', [], 'native date.js'),
  ];
  // 80 samples under Search, 40 under Reports.
  const samples = [...Array.from({ length: 80 }, () => 4), ...Array.from({ length: 40 }, () => 7)];
  const raw = attachMeasuredTasks(profile(shared, samples), [{ ts: 1000, dur: 120_000 }]);
  const [card] = cardsFor(raw, 240).cards;

  const search = card.boundaryFrames.find((entry) => entry.name === 'Search_Search');
  const reports = card.boundaryFrames.find((entry) => entry.name === 'Reports_Reports');
  assert.equal(search.totalMs, 80);
  assert.equal(reports.totalMs, 40);

  const inside = (frame) => frame.culprits.find((entry) => entry.name === 'toLocaleString');
  assert.equal(inside(search).selfMs, 80);
  assert.equal(inside(reports).selfMs, 40);
  // The task-level culprit still reports the whole 120 ms: the two readings are
  // of different wholes, and each sums to its own.
  assert.equal(card.culprits.find((entry) => entry.name === 'toLocaleString').selfMs, 120);
  // One run under each feature, not two runs task-wide, because masking the
  // samples to a subtree is what the drill-down's shapes are measured against.
  assert.equal(inside(search).invocations, 1);
  assert.equal(inside(reports).invocations, 1);
});

test('what never reached a frame of your own is reported rather than left in a remainder', () => {
  // Half the task is React with nothing of the product's on the stack. That is
  // not a smaller feature and it is not a culprit; it is the reason the shown
  // frames do not add up to the block.
  const framework = [
    node(0, '(root)', [1], ''),
    node(1, 'performWorkOnRoot', [2, 3], 'node_modules/react-dom/index.js'),
    node(2, 'Search_Search', [], 'src/screens/Search.tsx', 11),
    node(3, 'commitMutationEffects', [], 'node_modules/react-dom/index.js'),
  ];
  const samples = [...Array.from({ length: 100 }, () => 2), ...Array.from({ length: 100 }, () => 3)];
  const raw = attachMeasuredTasks(profile(framework, samples), [{ ts: 1000, dur: 200_000 }]);
  const [card] = cardsFor(raw, 400).cards;

  assert.deepEqual(card.boundaryFrames.map((entry) => entry.name), ['Search_Search']);
  assert.equal(card.boundaryFrames[0].totalMs, 100);
  assert.equal(card.boundaryTailCount, 0);
  assert.equal(card.boundaryTailMs, 0);
  assert.equal(card.outsideBoundariesMs, 100);
  // The three figures account for the block exactly, which is what lets the
  // chart draw them as parts of one whole.
  const accounted = card.boundaryFrames.reduce((sum, entry) => sum + entry.totalMs, 0)
    + card.boundaryTailMs + card.outsideBoundariesMs;
  assert.equal(accounted, card.durationMs);
});

/**
 * The two candidate headings, which are measured from a finished card rather
 * than from the tree — so they are asserted against hand-written cards as well
 * as against built ones, to pin the branch each reading comes from.
 */
const culprit = (name, selfMs, overrides = {}) => ({
  name, selfMs, totalMs: selfMs, frameClass: 'native', invocations: 1, longestCallMs: selfMs,
  shapeText: '', nodeId: '0.0', callers: [], reachedVia: [], hotPath: [], ...overrides,
});

const feature = (name, totalMs, culprits = []) => ({ name, totalMs, culprits });

const bare = (overrides) => ({
  durationMs: 1000, outsideBoundariesMs: 0, subtreeFunctionCount: 40,
  culprits: [], boundaryFrames: [], ...overrides,
});

test('the path line places the heaviest culprit in the feature that reached it', () => {
  const { cards } = cardsFor(oneTask, 400);
  // `toLocaleString` is the engine built-in that burned the task, reached
  // through two frames of the product's own. The line stops above it: a native
  // frame is not a file anyone can open, and the shape line names it anyway.
  assert.equal(cards[0].pathline, 'Search_Search › applyMerge');
});

test('the path line ends at the culprit when the culprit is code of your own', () => {
  const card = bare({
    culprits: [culprit('applyMerge', 400, { frameClass: 'app', callers: ['Search_Search'] })],
    boundaryFrames: [{ name: 'Search_Search', culprits: [{ name: 'applyMerge' }] }],
  });
  assert.equal(pathlineFor(card), 'Search_Search › applyMerge');
});

test('the path line anchors on the feature when the caller chain was clipped', () => {
  // `callers` keeps three frames, so a deep stack loses the feature off the
  // top. The ellipsis says frames were skipped rather than implying the
  // feature called the first one directly.
  const card = bare({
    culprits: [culprit('toLocaleString', 400, { callers: ['one', 'two', 'three'] })],
    boundaryFrames: [{ name: 'Search_Search', culprits: [{ name: 'toLocaleString' }] }],
  });
  assert.equal(pathlineFor(card), 'Search_Search › … › one › two › three');
});

test('the path line falls back to the features when nothing cleared the culprit floor', () => {
  const card = bare({ boundaryFrames: [{ name: 'Search_Search', culprits: [] }, { name: 'Reports', culprits: [] }] });
  assert.equal(pathlineFor(card), 'Search_Search › Reports');
});

test('the shape line reads a dominant culprit as a share, a count and a worst call', () => {
  const card = bare({ culprits: [culprit('toLocaleString', 740, { invocations: 8, longestCallMs: 196 })] });
  assert.equal(shapelineFor(card), '74% in toLocaleString · 8 calls, longest 196 ms');
});

test('the shape line tells one slow call apart from a cheap one paid per item', () => {
  // The distinction the merged call tree cannot draw, and the one that decides
  // whether the fix is inside the callee or at the call site.
  const once = bare({ culprits: [culprit('jsonParse', 840, { totalMs: 840 })] });
  assert.equal(shapelineFor(once), '84% in jsonParse · one 840 ms call');
});

test('a share is measured against the code that ran, not against the task', () => {
  // 600 ms of the task never reached the product's code, so the 300 ms frame is
  // 75% of the 400 ms that did — and the line says 400 ms first, because 75%
  // beside a 1000 ms time label would otherwise invite multiplying the two.
  const card = bare({ outsideBoundariesMs: 600, culprits: [culprit('toLocaleString', 300)] });
  assert.equal(shapelineFor(card), '400 ms in your code · 75% in toLocaleString · one 300 ms call');
});

test('one frame is read the same way however much framework time sat beside it', () => {
  // The bug this denominator fixes. The same 300 ms frame, the same 400 ms of
  // the product's own code, in a short task and in a long one: measured against
  // the task it was dominant on the first and invisible on the second, which
  // made a card's finding depend on something the frame had no part in.
  const short = bare({ durationMs: 500, outsideBoundariesMs: 100, culprits: [culprit('toLocaleString', 300)] });
  const long = bare({ durationMs: 50000, outsideBoundariesMs: 49600, culprits: [culprit('toLocaleString', 300)] });
  assert.match(shapelineFor(short), /75% in toLocaleString/);
  assert.match(shapelineFor(long), /75% in toLocaleString/);
});

test('a task with no frame of your own anywhere in it has no share to report', () => {
  // Nothing of the reader's own ran, so there is no whole to measure against
  // and the row says that rather than dividing by zero or printing a 0%.
  const card = bare({ outsideBoundariesMs: 1000 });
  assert.equal(shapelineFor(card), 'no code of your own ran in this block');
});

test('a task split between features is read as that split, not as one frame in one of them', () => {
  // The case the framework early-return used to swallow: half the task outside,
  // the rest divided between two features. Both are named, and the shares are
  // of the 3.22 s that reached the product's code, so they add up to it.
  const card = bare({
    durationMs: 6490,
    outsideBoundariesMs: 3270,
    culprits: [culprit('arrayPrototypeSort', 400)],
    boundaryFrames: [feature('_onFocus', 2420), feature('_onChange', 760), feature('tiny', 37)],
    segments: [{ title: 'sort' }, { title: 'format' }],
  });
  assert.equal(shapelineFor(card), '3.22 s in your code · 75% _onFocus · 24% _onChange');
});

test('a task spread across many features is not reported as a split between two of them', () => {
  // The 17/11/9/7/6/5/5/3 shape of a real search render. The top two hold 28%
  // between them, so naming them would present a corner of the task as its
  // shape — the segments are the honest reading, and the path line keeps its
  // path rather than collapsing to two feature names.
  const card = bare({
    durationMs: 3227,
    outsideBoundariesMs: 462,
    culprits: [culprit('getReportSections', 193, { frameClass: 'library', callers: ['hooks_useSearchSnapshot', 'getSections'] })],
    boundaryFrames: [
      feature('Search_Search', 548), feature('flushRecompute', 355), feature('keysChanged', 306),
      feature('Search_SearchTypeMenuWide', 229), feature('applyMerge', 187),
    ],
    segments: [{ title: 'getReportSections' }, { title: 'flushRecompute' }, { title: 'fireCallbacks' }],
  });
  assert.equal(shapelineFor(card), '3 distinct pieces of work · getReportSections, flushRecompute, fireCallbacks');
  assert.equal(pathlineFor(card), 'Search_Search › … › hooks_useSearchSnapshot › getSections › getReportSections');
});

test('the path line names the features when the task is split between them', () => {
  const card = bare({
    durationMs: 6490,
    culprits: [culprit('arrayPrototypeSort', 900, { callers: ['_onFocus'] })],
    boundaryFrames: [feature('_onFocus', 2420), feature('_onChange', 760), feature('tiny', 37)],
  });
  assert.equal(pathlineFor(card), '_onFocus + _onChange');
});

test('the path line still builds a path when one feature is the task', () => {
  const card = bare({
    culprits: [culprit('applyMerge', 400, { frameClass: 'app', callers: ['Search_Search'] })],
    boundaryFrames: [feature('Search_Search', 800, [{ name: 'applyMerge' }]), feature('Reports', 120)],
  });
  assert.equal(pathlineFor(card), 'Search_Search › applyMerge');
});

test('a culprit that is a sliver of the task is still the finding when it is most of the code that ran', () => {
  // The real shape of a 50.6 s task that spent 93% of itself in the framework:
  // the heaviest frame is 6% of the task and 77% of the 3.79 s that reached the
  // product's code. Both rows report it — the path names the caller it came
  // from, the shape names the frame and the 3.79 s it is a share of.
  const card = bare({
    durationMs: 50560,
    outsideBoundariesMs: 46770,
    culprits: [culprit('[Native] datePrototypeToLocaleStringHelper', 2923, {
      callers: ['_onFocus', 'findFeaturedReviewer'], invocations: 97, longestCallMs: 135,
    })],
    boundaryFrames: [feature('_onFocus', 2948)],
  });
  assert.equal(pathlineFor(card), '_onFocus › findFeaturedReviewer');
  assert.equal(shapelineFor(card),
    '3.79 s in your code · 77% in [Native] datePrototypeToLocaleStringHelper · 97 calls, longest 135 ms');
});

test('a long task with no dominant frame is read as its segments', () => {
  const card = bare({
    culprits: [culprit('toLocaleString', 100)],
    segments: [{ title: 'startup' }, { title: 'first render' }],
  });
  assert.equal(shapelineFor(card), '2 distinct pieces of work · startup, first render');
});

test('a diffuse task says so, and says how thin the heaviest frame was', () => {
  const card = bare({ culprits: [culprit('toLocaleString', 90)], subtreeFunctionCount: 512 });
  assert.equal(shapelineFor(card), 'no single hot frame · heaviest 9% (toLocaleString) of 512 functions');
});

test('neither line claims a figure on a block with no measurable duration', () => {
  assert.equal(shapelineFor(bare({ durationMs: 0 })), 'no measurable work in this block');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { selectTaskCards } from '../src/lib/task-cards.ts';
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

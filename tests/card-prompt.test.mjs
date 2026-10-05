import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallTree } from '../src/lib/call-tree.ts';
import { selectCards } from '../src/lib/profile-cards.ts';
import { buildCardPrompt, buildTaskPrompt } from '../src/lib/card-prompt.ts';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { selectTaskCards } from '../src/lib/task-cards.ts';
import { attachMeasuredTasks, extractTasks } from '../src/lib/tasks.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

const nodes = [
  node(0, '(root)', [1, 9], ''),
  node(1, 'onPressSubmit', [2]), node(2, 'buildReport', [3, 4]),
  node(3, 'getTotal', [5]), node(4, 'renderRow', [6]),
  node(5, 'format', [], 'fmt.js', 11), node(6, 'format', [], 'fmt.js', 11),
  node(9, 'backgroundWork', [], 'bg.js'),
];
const samples = [2, 2, 3, 5, 5, 5, 4, 6, 6, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
const dense = Array.from({ length: 60 }, () => samples).flat();
const selection = selectCards(buildCallTree({ nodes, samples: dense, startTime: 0, endTime: 1 }, 2000));
const card = selection.cards.find((entry) => entry.title === 'buildReport');
const prompt = buildCardPrompt(card, selection.durationMs, selection.callCountIsExact);

test('the prompt leads with inclusive and self time, and the profile share', () => {
  assert.match(prompt, /^## Issue and impact\n/);
  assert.match(prompt, new RegExp(`buildReport.*accounts for ${card.totalMs} ms of total time`));
  assert.match(prompt, new RegExp(`${card.selfMs} ms of that is spent in its own body`));
  assert.match(prompt, /% of the 2000 ms profile/);
});

test('every highlight is reported with both of its times', () => {
  assert.ok(card.highlights.length > 0);
  for (const highlight of card.highlights) {
    assert.ok(
      prompt.includes(`${highlight.name}`) && prompt.includes(`${highlight.totalMs} ms total, ${highlight.selfMs} ms self`),
      `missing ${highlight.name}`,
    );
  }
});

test('repeated helpers are reported with their callers and combined cost', () => {
  const format = card.repeated.find((entry) => entry.name === 'format');
  assert.ok(format, 'format should roll up as repeated work');
  assert.match(prompt, /## Repeated work underneath/);
  assert.match(prompt, new RegExp(`format — 2 call sites from getTotal and 1 other caller, ${format.totalMs} ms total`));
});

test('both directions of the stack are present and labelled', () => {
  assert.match(prompt, /## How this code is reached/);
  assert.ok(prompt.includes('onPressSubmit'), 'the entry point belongs in the upward path');
  assert.match(prompt, /## Where the time burns below it/);
});

test('a sampling profile never claims invocation counts', () => {
  assert.match(prompt, /distinct recorded call sites/);
  assert.ok(!/called \d+ times/.test(prompt), 'sampled profiles must not claim invocations');
});

test('a duration trace is allowed to claim real invocation counts', () => {
  const exact = selectCards(buildCallTree({ nodes, samples: dense, startTime: 0, endTime: 1 }, 2000, { callCountIsExact: true }));
  const exactCard = exact.cards.find((entry) => entry.title === 'buildReport');
  const exactPrompt = buildCardPrompt(exactCard, exact.durationMs, true);
  assert.match(exactPrompt, /called \d+ time/);
  assert.match(exactPrompt, /real invocation counts/);
});

test('a long-tail card does not claim the function body is slow', () => {
  // A hundred cells of 12 ms: every one is under the floor, so the parent is
  // all that is left to name.
  const cells = Array.from({ length: 100 }, (_, index) => index + 2);
  const tail = selectCards(buildCallTree({
    nodes: [node(0, '(root)', [1], ''), node(1, 'renderList', cells), ...cells.map((id) => node(id, `cell${id}`))],
    samples: Array.from({ length: 60 }, () => cells).flat(),
    startTime: 0, endTime: 1,
  }, 1200));
  const tailCard = tail.cards.find((entry) => entry.title === 'renderList');
  assert.equal(tailCard.selfShape, 'longTail');
  const tailPrompt = buildCardPrompt(tailCard, tail.durationMs, false);
  assert.match(tailPrompt, /spread across small calls underneath it/);
  assert.ok(!tailPrompt.includes('spent in its own body'));
});

// --- Task cards -----------------------------------------------------------

const taskNode = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

const taskNodes = [
  taskNode(0, '(root)', [1], ''),
  taskNode(1, 'Search_Search', [2], 'src/screens/Search.tsx', 11),
  taskNode(2, 'applyMerge', [3], 'src/screens/merge.ts', 4),
  taskNode(3, 'toLocaleString', [], 'native date.js'),
];
const taskSamples = Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 2 : 3));
const taskProfileRaw = attachMeasuredTasks(
  { nodes: taskNodes, samples: taskSamples, timeDeltas: taskSamples.map(() => 1000), startTime: 0, endTime: 400_000 },
  [{ ts: 1000, dur: 200_000 }],
);
const taskSet = selectTaskCards(taskProfileRaw, 400, extractTasks(taskProfileRaw), ruleClassTable());
const taskCard = taskSet.cards[0];
const taskPrompt = buildTaskPrompt(taskCard, 400);

test('the task prompt leads with wall-clock timing and says the boundary was measured', () => {
  assert.match(taskPrompt, /^## The task\n/);
  assert.match(taskPrompt, /one task of 200 ms starting 1 ms into the recording, 50% of the 400 ms recording/);
  assert.match(taskPrompt, /recorded this boundary itself/);
});

test('the boundary chain names the feature, not the frame doing the work', () => {
  assert.match(taskPrompt, /outermost application code on this task's stacks: `Search_Search`/);
});

test('every culprit carries its invocation shape', () => {
  assert.match(taskPrompt, /## Where the task's time went/);
  const hot = taskCard.culprits.find((culprit) => culprit.name === 'toLocaleString');
  assert.ok(hot.invocations > 1, 'the fixture should produce a repeatedly called culprit');
  assert.ok(
    taskPrompt.includes(`Ran ${hot.invocations} times inside this task, ${hot.totalMs} ms inclusive across them, longest single call ${hot.longestCallMs} ms.`),
    taskPrompt,
  );
});

test('both directions of the stack are present for the culprits that get one', () => {
  assert.match(taskPrompt, /Reached from the task root:/);
  assert.ok(taskPrompt.includes('Search_Search'), 'the entry point belongs in the upward path');
  assert.match(taskPrompt, /Where its time burns below it:/);
});

test('the prompt stays evidence and never states a cause', () => {
  // The receiving agent can open the source; this tool has only names and
  // numbers, and a guessed root cause here would anchor it wrongly.
  assert.match(taskPrompt, /has not read any source file/);
  for (const word of ['because', 'root cause', 'you should', 'the problem is']) {
    assert.ok(!taskPrompt.toLowerCase().includes(word), `the prompt should not assert a cause: "${word}"`);
  }
});

test('an inferred boundary is marked approximate in the prompt too', () => {
  const loose = { nodes: taskNodes, samples: taskSamples, timeDeltas: taskSamples.map(() => 1000), startTime: 0, endTime: 400_000 };
  const inferred = selectTaskCards(loose, 400, extractTasks(loose), ruleClassTable());
  const inferredPrompt = buildTaskPrompt(inferred.cards[0], 400);
  assert.match(inferredPrompt, /About \d+ ms of uninterrupted work starting around/);
  assert.match(inferredPrompt, /reconstructed from the gaps between sample runs, so its edges are approximate/);
  assert.ok(!inferredPrompt.includes('recorded this boundary itself'));
});

/**
 * Thirty frames, each burning 20 ms of its own time inside one 600 ms task, so
 * every one of them clears the culprit floor on self time alone.
 */
const manyNodes = [
  node(0, '(root)', [1], ''),
  node(1, 'renderScreen', Array.from({ length: 30 }, (_, index) => index + 2), 'src/screen.tsx', 3),
  ...Array.from({ length: 30 }, (_, index) => node(index + 2, `step${index}`, [], 'src/steps.ts', index)),
];
const manySamples = Array.from({ length: 600 }, (_, index) => 2 + Math.floor(index / 20));
const manyRaw = attachMeasuredTasks(
  { nodes: manyNodes, samples: manySamples, timeDeltas: manySamples.map(() => 1000), startTime: 0, endTime: 600_000 },
  [{ ts: 1000, dur: 600_000 }],
);
const manyCard = selectTaskCards(manyRaw, 600, extractTasks(manyRaw), ruleClassTable()).cards[0];

test('the table holds every frame over the floor where the old cap would have cut it', () => {
  // 30 frames at 20 ms self, plus the frame that called them: past the cap of
  // 24 this list used to carry, and well under the one it carries now.
  assert.equal(manyCard.culprits.filter((culprit) => culprit.selfMs >= 15).length, 30);
  assert.equal(manyCard.culprits.length, 31);
});

test('the hand-off lists a readable head of that table and accounts for the rest', () => {
  const prompt = buildTaskPrompt(manyCard, 600);
  const listed = prompt.split('\n').filter((line) => /^- `step\d+`/.test(line));
  assert.ok(listed.length <= 24, `the prompt listed ${listed.length} culprits`);
  // Whatever the list leaves out is still accounted for, so the prompt never
  // drops a millisecond of the task on the floor.
  assert.match(prompt, /ms of the task is spread across frames smaller than the ones listed above\./);
});

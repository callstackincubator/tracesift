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
  assert.match(prompt, /^Use the evidence below to investigate the root cause/);
  assert.match(prompt, /\n## Issue and impact\n/);
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
const taskPrompt = buildTaskPrompt(taskCard);

test('the hand-off carries the code the task ran, not where it sat on the clock', () => {
  // Duration, offset and how the boundary was decided are on the card the
  // developer copied from; repeating them here spends lines the receiving agent
  // cannot act on.
  assert.match(taskPrompt, /^Use the evidence below to investigate the root cause of this 200 ms bottleneck/);
  assert.match(taskPrompt, /\n## The task\n/);
  assert.ok(!taskPrompt.includes('into the recording'), taskPrompt);
  assert.ok(!taskPrompt.includes('recorded this boundary itself'));
});

test('the boundary frames carry the numbers that account for the whole task', () => {
  // These frames are an antichain, so their inclusive times are disjoint and
  // divide the task. Printed as a bare list of names, which is what this
  // section used to be, the one measurement in the hand-off that adds up to the
  // block the reader clicked on was thrown away.
  assert.match(taskPrompt, /- `Search_Search` \(src\/screens\/Search\.tsx:12:1\) — 200 ms including everything it called, 100% of the task\./);
  assert.match(taskPrompt, /their times divide the task's 200 ms between them/);
});

test('a frame that delegates all of its time is an entry point, not a culprit', () => {
  // `applyMerge` burns 20 ms of its own and 200 ms through `toLocaleString`.
  // The inclusive figure belongs to the section above; a frame with no self
  // time at all used to reach the list below and read `0 ms of its own time`.
  const delegator = taskCard.culprits.find((culprit) => culprit.name === 'Search_Search');
  assert.ok(delegator, 'the fixture should produce a frame admitted on inclusive time alone');
  assert.ok(delegator.selfMs < 15, `Search_Search burned ${delegator.selfMs} ms of its own`);
  assert.ok(!/^- `Search_Search`.*of its own time/m.test(taskPrompt.slice(taskPrompt.indexOf("## Where the task's time went"))), taskPrompt);
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

test('the culprits are drawn in one tree with the frames joining them', () => {
  assert.match(taskPrompt, /## Where those frames sit/);
  assert.ok(taskPrompt.includes('Search_Search'), 'the entry point belongs above the culprits');
  assert.match(taskPrompt, /← [\d.]+ ms self/, 'a culprit is anchored where it sits');
});

test('the prompt stays evidence and never states a cause', () => {
  // The receiving agent can open the source; this tool has only names and
  // numbers, and a guessed root cause here would anchor it wrongly. The opening
  // line names the job — find the cause — and is the one place the phrase is
  // allowed, because asking for a thing is the opposite of asserting it; every
  // word below it is measured.
  assert.match(taskPrompt, /has not read any source file/);
  const evidence = taskPrompt.slice(taskPrompt.indexOf('\n\n')).toLowerCase();
  for (const word of ['because', 'root cause', 'you should', 'the problem is']) {
    assert.ok(!evidence.includes(word), `the prompt should not assert a cause: "${word}"`);
  }
  assert.match(taskPrompt.split('\n')[0], /investigate the root cause/);
  assert.match(taskPrompt.split('\n')[0], /reports where the time went and not why/);
});

test('the hand-off keeps one caveat: that nothing here read a source file', () => {
  const caveats = taskPrompt.slice(taskPrompt.indexOf('## How to read these numbers')).trim().split('\n');
  assert.equal(caveats.length, 2, caveats.join('\n'));
  assert.match(caveats[1], /has not read any source file/);
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

test('the hand-off names enough of that table to account for most of the task', () => {
  const prompt = buildTaskPrompt(manyCard);
  const listed = prompt.split('\n').filter((line) => /^- `step\d+`/.test(line));
  assert.equal(listed.length, 25, `the prompt listed ${listed.length} culprits`);
  // The floor this replaced was 2% of the task, which on this 600 ms block cut
  // at 12 ms — every one of these frames cleared it, so the cap bound instead
  // and printed 12 rows covering 40% of the duration. The point of the list is
  // that the task adds up.
  const burned = manyCard.culprits.filter((culprit) => culprit.selfMs >= 15);
  const named = burned.slice(0, 25).reduce((sum, culprit) => sum + culprit.selfMs, 0);
  assert.ok(named / manyCard.durationMs > 0.8, `${named} ms of ${manyCard.durationMs} ms named`);
  // Whatever the list leaves out is still accounted for, and what it is spread
  // across is said as a measurement rather than as a shrug.
  assert.match(prompt, /ms of the task is spread across frames smaller than the ones listed above\. 5 more frames ranked below these, the largest at [\d.]+ ms of its own time; the rest are smaller still\./);
});

test('an inference heads the hand-off, labelled, with the measured evidence still under it', () => {
  const prompt = buildTaskPrompt(
    { ...taskCard, insight: { title: 'Re-formatting every row', findings: ['toLocaleString runs per row inside applyMerge.'] } },
    400,
  );
  assert.match(prompt, /## What this looks like\n\*\*Re-formatting every row\*\*/);
  assert.match(prompt, /- toLocaleString runs per row inside applyMerge\./);
  // The receiving agent is told which part of the message was guessed.
  assert.match(prompt, /not a measurement/);
  // And still gets everything the measured hand-off carried.
  assert.match(prompt, /## The task/);
  assert.match(prompt, /## Where the task's time went/);
  assert.ok(prompt.indexOf('## What this looks like') < prompt.indexOf('## The task'));
});

test('without an inference the hand-off is exactly what it was', () => {
  assert.equal(buildTaskPrompt(taskCard).includes('What this looks like'), false);
});

/**
 * A task shaped like the ones that made the hand-off unreadable: minified
 * vendor frames carrying real cost, a recursive walk, and every position a
 * hashed bundle URL rather than a file.
 */
const VENDOR = 'https://app.example.com/vendors-0776745712aedaa7.bundle.js';
const MAIN = 'https://app.example.com/main-486aba692c7c7999.bundle.js';
const minifiedNodes = [
  node(0, '(root)', [1], ''),
  node(1, 'Search_Search', [2, 6], 'src/screens/Search.tsx', 11),
  node(2, 'setWithRetry', [3], MAIN, 1),
  node(3, 'removeNestedNullValues', [4], VENDOR, 191),
  node(4, 'removeNestedNullValues', [5], VENDOR, 191),
  node(5, 'removeNestedNullValues', [], VENDOR, 191),
  node(6, 't.A', [7], VENDOR, 20),
  node(7, 'getReportSections', [8], MAIN, 90),
  node(8, 'isEmptyObject', [], MAIN, 300),
];
const minifiedSamples = [
  ...Array.from({ length: 200 }, () => 6),
  ...Array.from({ length: 120 }, () => 3),
  ...Array.from({ length: 40 }, () => 4),
  ...Array.from({ length: 40 }, () => 5),
  ...Array.from({ length: 100 }, () => 7),
  ...Array.from({ length: 100 }, () => 8),
];
const minifiedRaw = attachMeasuredTasks(
  { nodes: minifiedNodes, samples: minifiedSamples, timeDeltas: minifiedSamples.map(() => 1000), startTime: 0, endTime: 1_000_000 },
  [{ ts: 0, dur: 600_000 }],
);
const minifiedCard = selectTaskCards(minifiedRaw, 1000, extractTasks(minifiedRaw), ruleClassTable()).cards[0];
const minifiedPrompt = buildTaskPrompt(minifiedCard);

test('a frame inside a bundle is named by its chunk, never by the whole URL', () => {
  // The stacks the card ships are built from the same labels Explore draws.
  const recursive = minifiedCard.culprits.find((culprit) => culprit.name === 'removeNestedNullValues');
  assert.ok(recursive.reachedVia.includes('removeNestedNullValues (vendors.bundle.js:192:1)'), recursive.reachedVia.join('\n'));
  assert.ok(recursive.reachedVia.includes('setWithRetry (main.bundle.js:2:1)'));
  assert.ok(!recursive.reachedVia.some((frame) => frame.includes('https://app.example.com/')), 'the origin repeats on every line and distinguishes nothing');
  assert.ok(!recursive.reachedVia.some((frame) => frame.includes('0776745712aedaa7')), 'the content hash changes with every build');
});

test('a frame that only recurses says so instead of drawing itself seven times', () => {
  assert.match(minifiedPrompt, /`removeNestedNullValues`.*It recurses into itself\./);
  const drawn = minifiedPrompt.split('\n').filter((line) => /^[│├└─ ]*removeNestedNullValues/.test(line));
  assert.equal(drawn.length, 1, minifiedPrompt);
});

test('the tree reaches every culprit, including the ones no stack would have been spent on', () => {
  const tree = minifiedPrompt.slice(minifiedPrompt.indexOf('## Where those frames sit'));
  for (const name of ['removeNestedNullValues', 'getReportSections', 'isEmptyObject', 't.A']) {
    assert.ok(tree.includes(name), `${name} is missing from the tree:\n${tree}`);
  }
  // `t.A` has no name to grep and no file to open, and it is still the single
  // largest cost in the task — in a tree it costs one line and carries the
  // branch its two culprits hang off.
  assert.match(tree, /t\.A \(vendors\.bundle\.js:21:1\) {2}← 200\.3 ms self/);
});

test('a shared chain above the culprits is drawn once, not once per culprit', () => {
  const tree = minifiedPrompt.slice(minifiedPrompt.indexOf('## Where those frames sit'));
  const roots = tree.split('\n').filter((line) => line.includes('Search_Search'));
  assert.equal(roots.length, 1, tree);
  // And the branch point is visible as one: both costs hang off that render.
  assert.equal(tree.split('\n').filter((line) => line.startsWith('├─ ') || line.startsWith('└─ ')).length, 2, tree);
});

test('every culprit row carries the callers that locate it in the codebase', () => {
  assert.match(minifiedPrompt, /- `getReportSections`.*Called via Search_Search › t\.A\./);
  assert.match(minifiedPrompt, /- `removeNestedNullValues`.*Called via Search_Search › setWithRetry\./);
});

/**
 * A React stack as it actually arrives: a long run of reconciler frames above a
 * product frame that the classifier, unable to see into the bundle, filed as a
 * dependency rather than as `app`.
 */
const foldedNodes = [
  node(0, '(root)', [1], ''),
  node(1, 'performWorkOnRoot', [2], VENDOR, 10),
  node(2, 'performUnitOfWork', [3], VENDOR, 20),
  node(3, 'beginWork', [4], VENDOR, 30),
  node(4, 'renderWithHooks', [5], VENDOR, 40),
  node(5, 'buildReportRows', [6], VENDOR, 50),
  node(6, 'formatCurrency', [], VENDOR, 60),
];
const foldedSamples = Array.from({ length: 300 }, () => 6);
const foldedRaw = attachMeasuredTasks(
  { nodes: foldedNodes, samples: foldedSamples, timeDeltas: foldedSamples.map(() => 1000), startTime: 0, endTime: 300_000 },
  [{ ts: 0, dur: 300_000 }],
);
const foldedCard = selectTaskCards(foldedRaw, 300, extractTasks(foldedRaw), ruleClassTable()).cards[0];
const foldedPrompt = buildTaskPrompt(foldedCard);

test('a summarised run says what it was made of', () => {
  // `… (4 frames)` asserts that something was hidden without saying what kind
  // of thing, so a reader cannot tell "that is all React" from "the frame I
  // need is in there".
  assert.match(foldedPrompt, /… \(4 framework frames\)/);
});

test('a product frame the bundle hid from the classifier is still never folded away', () => {
  // The guard here was `frameClass === "app"`, and a frame inside a bundle is
  // routinely filed under `library` instead — which folded the one frame on the
  // branch a developer could act on into the summary above it.
  assert.equal(foldedCard.culprits.find((culprit) => culprit.name === 'buildReportRows')?.frameClass, 'library');
  assert.match(foldedPrompt, /^└─ buildReportRows$/m, foldedPrompt);
});

test('a chunk offset is printed only where the name cannot locate the frame', () => {
  // A name an agent can grep is the better key, and the chunk beside it is an
  // offset into a build artefact that cannot be opened and changes on the next
  // build. A mangled name is not that, so it keeps its position.
  assert.match(minifiedPrompt, /- `removeNestedNullValues` — /);
  assert.match(minifiedPrompt, /- `getReportSections` — /);
  assert.ok(!minifiedPrompt.includes('getReportSections (main.bundle.js'), minifiedPrompt);
  assert.match(minifiedPrompt, /t\.A \(vendors\.bundle\.js:21:1\)/);
  assert.match(minifiedPrompt, /- A position that names a bundle chunk rather than a source file is an offset into a build artefact/);
  // A path a developer can open is still printed whole, wherever it appears.
  assert.match(minifiedPrompt, /Search_Search \(src\/screens\/Search\.tsx:12:1\)/);
  assert.ok(!minifiedPrompt.includes('https://app.example.com/'), 'the origin repeats on every line and distinguishes nothing');
  assert.ok(!minifiedPrompt.includes('0776745712aedaa7'), 'the content hash changes with every build');
});

test('a hand-off with no build artefact in it does not explain what one is', () => {
  const caveats = taskPrompt.slice(taskPrompt.indexOf('## How to read these numbers')).trim().split('\n');
  assert.equal(caveats.length, 2, caveats.join('\n'));
});

/**
 * Two different functions minification left sharing a name, which is the case
 * that makes a position worth printing: on the trace this was written for, two
 * `compute` frames carried the same name and the same caller chain.
 */
const twinNodes = [
  node(0, '(root)', [1], ''),
  node(1, 'flushRecompute', [2, 3], MAIN, 1),
  node(2, 'compute', [], MAIN, 113),
  node(3, 'compute', [], MAIN, 124),
];
const twinSamples = [...Array.from({ length: 200 }, () => 2), ...Array.from({ length: 100 }, () => 3)];
const twinRaw = attachMeasuredTasks(
  { nodes: twinNodes, samples: twinSamples, timeDeltas: twinSamples.map(() => 1000), startTime: 0, endTime: 300_000 },
  [{ ts: 0, dur: 300_000 }],
);
const twinCard = selectTaskCards(twinRaw, 300, extractTasks(twinRaw), ruleClassTable()).cards[0];
const twinPrompt = buildTaskPrompt(twinCard);

test('two frames sharing a minified name keep the positions that tell them apart', () => {
  // Dropping these would leave two identical rows for two different functions.
  assert.match(twinPrompt, /- `compute` \(main\.bundle\.js:114:1\) — /);
  assert.match(twinPrompt, /- `compute` \(main\.bundle\.js:125:1\) — /);
  // The frame they share a chain with is named once and needs no position.
  assert.match(twinPrompt, /- `flushRecompute` — /);
});

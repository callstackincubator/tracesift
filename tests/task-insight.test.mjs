import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { selectTaskCards } from '../src/lib/task-cards.ts';
import { attachMeasuredTasks, extractTasks } from '../src/lib/tasks.ts';
import { AgentError } from '../src/lib/pi-agent.ts';
import { inferTaskInsights, insightPrompt, parseInsight, timelineDigest } from '../src/lib/task-insight.ts';

const node = (id, name, children = [], url = 'app.js', line = 0) => ({
  id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
});

const profile = (nodes, samples, startTime = 0) => ({
  nodes, samples,
  timeDeltas: samples.map(() => 1000),
  startTime,
  endTime: startTime + samples.length * 1000,
});

const nodes = [
  node(0, '(root)', [1], ''),
  node(1, 'performWorkOnRoot', [2], 'node_modules/react-dom/index.js'),
  node(2, 'Search_Search', [3], 'src/screens/Search.tsx', 11),
  node(3, 'applyMerge', [4], 'src/screens/merge.ts', 4),
  node(4, 'toLocaleString', [], 'native date.js'),
];

const busy = Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 3 : 4));
const raw = attachMeasuredTasks(profile(nodes, busy), [{ ts: 1000, dur: 200_000 }]);
const card = selectTaskCards(raw, 400, extractTasks(raw), ruleClassTable()).cards[0];

const box = (depth, name, startMs, durationMs, selfMs = durationMs) => ({
  depth, name, frameClass: 'app', startMs, durationMs, selfMs, nodeId: `${depth}-${startMs}`,
});

test('the digest keeps the chart a tree: a dropped call takes its descendants with it', () => {
  const boxes = [box(0, 'wide', 0, 100, 2), box(1, 'narrow', 0, 0.01), box(2, 'under narrow', 0, 0.01)];
  const { lines, omitted } = timelineDigest(boxes, 100);
  assert.equal(omitted, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /wide/);
});

test('the digest fits the prompt however many boxes the task drew', () => {
  // One box per millisecond of a two-second task is far past the line cap, so
  // the floor has to climb until what is left can be read.
  const boxes = Array.from({ length: 2000 }, (_, index) => box(0, `call${index}`, index, 1));
  const { lines, omitted } = timelineDigest(boxes, 2000);
  assert.ok(lines.length <= 120, `expected at most 120 lines, got ${lines.length}`);
  assert.equal(lines.length + omitted, 2000);
});

test('a line carries the offset, so the model can see repetition rather than a total', () => {
  const { lines } = timelineDigest([box(0, 'parse', 0, 20, 4), box(1, 'inner', 1, 10)], 40);
  assert.match(lines[0], /^@0 ms parse — 20 ms, 4 ms of it its own$/);
  // Nesting is indentation, and a leaf prints one figure rather than the same one twice.
  assert.equal(lines[1], '  @1 ms inner — 10 ms');
});

test('the prompt hands over the scoped timeline and the measured culprits', () => {
  const prompt = insightPrompt(card);
  assert.match(prompt, /## The timeline/);
  assert.match(prompt, /## Where the task's own time went/);
  assert.match(prompt, /applyMerge/);
  // The task against the clock, not the whole recording.
  assert.match(prompt, /one task of 200 ms, starting 1 ms into the recording/);
});

test('a reply that is not one usable object leaves the card measured', () => {
  assert.equal(parseInsight('I could not analyze this task.'), undefined);
  assert.equal(parseInsight('{"title":"Something"}'), undefined, 'a title with no findings is a claim with no evidence');
  assert.equal(parseInsight('{"findings":["a thing happened"]}'), undefined, 'findings with no title cannot head the card');
  assert.equal(parseInsight('{"title":"x",'), undefined);
});

test('a usable reply is read out of surrounding prose, and kept whole', () => {
  const title = 't'.repeat(200);
  const insight = parseInsight(`Here you go:\n{"title":"${title}","findings":["- one","two","three","four","five",""]}`);
  assert.ok(insight);
  // A long answer is the model overrunning a budget it was given, not a reason
  // to cut the call site or the offset off the end of a finding.
  assert.equal(insight.title, title, 'an overlong title is kept rather than truncated');
  assert.equal(insight.findings.length, 4);
  assert.equal(insight.findings[0], 'one', 'a bullet marker the model added is not part of the sentence');
});

test('one inference per task, and a failed one costs that task nothing but its bullets', async () => {
  const seen = [];
  const run = async ({ label, prompt }) => {
    seen.push({ label, prompt });
    if (label.endsWith('task-1')) throw new Error('provider unreachable');
    return {
      finalText: '{"title":"Re-formatting every row","findings":["toLocaleString runs per row inside applyMerge."]}',
      turns: 1, toolCalls: [], lastStopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costUsd: 0.001 },
      model: { provider: 'Anthropic', model: 'Claude' },
    };
  };

  const two = [{ ...card, id: 'task-1' }, { ...card, id: 'task-2' }];
  const { insights, usage, model } = await inferTaskInsights(two, '/tmp', run);

  assert.equal(seen.length, 2, 'one call per task');
  assert.equal(insights.has('task-1'), false, 'a failed call leaves that task measured');
  assert.equal(insights.get('task-2').title, 'Re-formatting every row');
  // Only the run that happened is billed.
  assert.equal(usage.totalTokens, 15);
  assert.equal(model.provider, 'Anthropic');
});

test('an empty reasoning-budget truncation gets one roomier retry', async () => {
  const attempts = [];
  const result = await inferTaskInsights([card], '/tmp', async (options) => {
    attempts.push(options);
    if (attempts.length === 1) {
      throw new AgentError(502, 'reasoning used the whole budget', 'reasoning_budget_exhausted');
    }
    return {
      finalText: '{"title":"Re-formatting every row","findings":["toLocaleString runs per row inside applyMerge."]}',
      turns: 1, toolCalls: [], lastStopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costUsd: 0 },
    };
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map(({ maxOutputTokens, timeoutMs }) => ({ maxOutputTokens, timeoutMs })),
    [
      { maxOutputTokens: 8192, timeoutMs: 120_000 },
      { maxOutputTokens: 16_384, timeoutMs: 240_000 },
    ],
  );
  assert.equal(result.insights.get(card.id).title, 'Re-formatting every row');
});

test('a second empty reasoning-budget truncation ends after two attempts', async () => {
  let attempts = 0;
  const result = await inferTaskInsights([card], '/tmp', async () => {
    attempts += 1;
    throw new AgentError(502, 'reasoning used the whole budget', 'reasoning_budget_exhausted');
  });

  assert.equal(attempts, 2);
  assert.equal(result.insights.size, 0);
});

test('other provider failures are not retried', async () => {
  let attempts = 0;
  const result = await inferTaskInsights([card], '/tmp', async () => {
    attempts += 1;
    throw new AgentError(502, 'provider unavailable');
  });

  assert.equal(attempts, 1);
  assert.equal(result.insights.size, 0);
});

test('no model is contacted when there is nothing to read', async () => {
  const { insights, usage } = await inferTaskInsights([], '/tmp', async () => { throw new Error('should not run'); });
  assert.equal(insights.size, 0);
  assert.equal(usage.totalTokens, 0);
});

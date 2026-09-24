import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBottlenecks } from '../src/lib/bottlenecks.ts';
import { normalizeHotspots } from '../src/lib/analysis.ts';
import { buildCpuFixPrompt } from '../src/lib/prompts.ts';
import { analysisPromptData, bottleneckPromptData, debugReactIssuePromptData, MAX_GROUP_PROMPT_BYTES } from '../src/lib/prompt-data.ts';

function largeGroup(id = 'b1') {
  return {
    id, title: 'render', combinedTimeMs: 10000, percentOfTotal: 100,
    stack: Array(100).fill('caller (app.js:1:1)'),
    functions: Array.from({length: 10000}, (_, i) => ({
      id: `${id}-f${i}`, title: `function${i}`, selfTimeMs: 1, percentOfGroup: 0.01,
      stack: Array(100).fill('heavy (bundle.js:1:1)'),
    })),
  };
}

test('large profiles retain measured totals but send only a bounded function summary', () => {
  const group = largeGroup();
  const data = bottleneckPromptData(group);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= MAX_GROUP_PROMPT_BYTES);
  assert.ok(data.functions.length <= 8);
  assert.equal(data.functions[0].id, 'b1-f0');
  assert.equal(data.combinedTimeMs, 10000);
  assert.equal(data.omittedFunctionCount + data.functions.length, 10000);
  assert.equal(data.otherSelfTimeMs + data.functions.reduce((n, fn) => n + fn.selfTimeMs, 0), 10000);
  assert.equal(group.functions.length, 10000);
  assert.equal(group.functions[0].stack.length, 100);
  assert.equal(data.functions[0].stack.at(-1), group.functions[0].stack.at(-1));
});

test('serialized budget includes unicode, escaped strings and very long labels', () => {
  const group = largeGroup();
  group.title = '\u0000😀'.repeat(1000);
  for (const fn of group.functions) {
    fn.title = group.title;
    fn.stack = Array(100).fill(group.title);
  }
  const groups = Array.from({length: 12}, (_, i) => ({...group, id: `b${i}`}));
  const data = analysisPromptData(groups);
  assert.equal(data.length, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 12 * MAX_GROUP_PROMPT_BYTES + 13);
  assert.ok(data.every(g => g.functions.length >= 1));
});


test('prompt separates grouping context from the descriptive title and qualifies stacks', () => {
  const group = largeGroup();
  group.title = 'dispatchEvent';
  const data = bottleneckPromptData(group);
  assert.equal(data.groupingCaller, 'dispatchEvent');
  assert.equal(data.title, undefined);
  assert.ok(data.functions.every(fn => !Object.hasOwn(fn, 'stackIsRepresentative')));
  assert.equal(Object.hasOwn(data, 'contextTruncated'), false);
  assert.equal(Object.hasOwn(data, 'functionCount'), false);
});

test('CPU hand-off is deterministic and carries measured impact plus representative origin', () => {
  const hotspot = {
    ...largeGroup(), title: 'Expensive markdown tokenization', groupingCaller: 'render',
    summary: ['regexpPrototypeExec used 6400 ms of self time.'],
    supportingFunctionIds: ['b1-f0', 'b1-f7'],
  };
  hotspot.functions[0] = {
    ...hotspot.functions[0], title: 'regexpPrototypeExec', location: 'src/markdown.ts:12:4',
    stack: ['regexpPrototypeExec', 'tokenizeMarkdown', 'buildMessagePreview', 'onMessagePress', 'dispatchEvent'],
  };
  const prompt = buildCpuFixPrompt(hotspot);
  assert.match(prompt, /^## Issue and Impact/m);
  assert.match(prompt, /10000 ms \(100% of the recorded profile\)/);
  assert.match(prompt, /regexpPrototypeExec used 6400 ms/);
  assert.match(prompt, /src\/markdown\.ts:12:4/);
  assert.match(prompt, /representative sampled path includes tokenizeMarkdown → buildMessagePreview → onMessagePress/);
  assert.doesNotMatch(prompt, /dispatchEvent/);
});

test('React issue prompt context uses the finding, not a second analysis of the profile', () => {
  const issue = {
    id: 'react-commit-1-3', summary: 'Expensive list work', severity: 'high',
    evidence: 'Own work in over-budget commits.',
    commit: { rootID: 1, commitIndex: 3, timestampMs: 300, durationMs: 30 },
    components: [{
      componentId: '1:4', component: 'ExpensiveList', severity: 'high',
      evidence: 'ExpensiveList used 24 ms self time.', selfTimeMs: 24, percentOfCommit: 80,
    }],
  };
  assert.deepEqual(debugReactIssuePromptData(issue), {
    summary: 'Expensive list work', evidence: 'Own work in over-budget commits.',
    severity: 'high', commit: { rootID: 1, commitIndex: 3, durationMs: 30 },
    components: [{ component: 'ExpensiveList', selfTimeMs: 24, percentOfCommit: 80, evidence: 'ExpensiveList used 24 ms self time.' }],
  });
  const oversized = debugReactIssuePromptData({ ...issue, summary: 'x'.repeat(100000), evidence: 'y'.repeat(100000) });
  assert.equal(oversized.summary.length, 2000);
  assert.equal(oversized.evidence.length, 2000);
  assert.equal(oversized.components.length, 1);
});

for (const handler of ['_onFocus', '_onChange']) {
  test(`analysis and hand-off preserve zero-self callers and ${handler} inside deep stacks`, () => {
    const names = [
      'dispatchEvent', 'batchedUpdates', 'executeDispatch', handler,
      ...Array(30).fill('performWork'), 'getUserName', 'sort', '(anonymous)',
      'toLocaleString', 'format', 'nativeFormat',
    ];
    const nodes = names.map((functionName, index) => ({
      id: index,
      children: index + 1 < names.length ? [index + 1] : [],
      callFrame: {
        functionName, scriptId: '1', lineNumber: 41, columnNumber: 6,
        url: functionName === 'getUserName' ? 'src/explore.tsx' : 'http://localhost:8081/index.bundle',
      },
    }));
    const groups = groupBottlenecks({ nodes, samples: [nodes.at(-1).id] }, 100);
    const hotspot = normalizeHotspots([], 100, groups).hotspots[0];
    assert.equal(hotspot.functions.length, 1);
    assert.equal(hotspot.functions[0].title, 'nativeFormat');
    for (const data of [bottleneckPromptData(groups[0])]) {
      const stack = data.functions[0].stack;
      assert.ok(stack.includes('getUserName (src/explore.tsx:42:7)'));
      assert.ok(stack.includes(handler));
      assert.ok(stack.indexOf('getUserName (src/explore.tsx:42:7)') < stack.indexOf(handler));
      assert.ok(stack.includes('toLocaleString'));
      assert.doesNotMatch(JSON.stringify(data), /https?:/);
      assert.equal(Object.hasOwn(data.functions[0], 'stackIsRepresentative'), false);
    }
    const prompt = buildCpuFixPrompt(hotspot);
    assert.match(prompt, new RegExp(handler));
    assert.match(prompt, /representative sampled path/);
  });
}

test('source locations retain readable paths but omit URL and unknown locations', () => {
  const group = largeGroup();
  group.functions = [group.functions[0]];
  group.functions[0].stack = [
    'local (explore.tsx:10:2)',
    'absolute (/workspace/src/explore.tsx:10:2)',
    String.raw`windows (C:\src\explore.tsx:10:2)`,
    'remote (https://example.com/explore.tsx:10:2)',
    'virtual (webpack://src/explore.tsx:10:2)',
    'unknown ((anonymous):0:0)',
  ];
  assert.deepEqual(bottleneckPromptData(group).functions[0].stack, [
    'local (explore.tsx:10:2)',
    'absolute (/workspace/src/explore.tsx:10:2)',
    String.raw`windows (C:\src\explore.tsx:10:2)`,
    'remote', 'virtual', 'unknown',
  ]);
});

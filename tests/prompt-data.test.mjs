import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBottlenecks } from '../src/lib/bottlenecks.ts';
import { normalizeHotspots } from '../src/lib/analysis.ts';
import { analysisPromptData, bottleneckPromptData, debugPromptData, debugReactIssuePromptData, MAX_GROUP_PROMPT_BYTES } from '../src/lib/prompt-data.ts';

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
  assert.equal(data.omittedSelfTimeMs + data.functions.reduce((n, fn) => n + fn.selfTimeMs, 0), 10000);
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
  assert.ok(data.functions.every(fn => fn.stackIsRepresentative === true));
});

test('debug prompt carries shortlisted functions and their recorded stacks', () => {
  const hotspot = {
    ...largeGroup(), groupingCaller: 'render', summary: ['Expensive formatting'],
    supportingFunctionIds: ['b1-f0', 'b1-f7'],
  };
  const data = debugPromptData(hotspot);
  assert.equal(data.summary, 'Expensive formatting');
  assert.equal(data.groupingCaller, 'render');
  assert.deepEqual(data.functions.map(fn => fn.title), ['function0', 'function7']);
  assert.ok(data.functions.every(fn => fn.stack.includes('heavy (bundle.js:1:1)')));
});

test('debug prompt context stays bounded even with oversized annotations and shortlists', () => {
  const hotspot = {
    ...largeGroup(), groupingCaller: 'render', summary: ['x'.repeat(100000)],
    supportingFunctionIds: Array.from({length: 10000}, (_, i) => `b1-f${i}`),
  };
  const data = debugPromptData(hotspot);
  assert.equal(data.summary.length, 2000);
  assert.ok(data.functions.length >= 1 && data.functions.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= MAX_GROUP_PROMPT_BYTES + 2100);
});

test('React issue prompt context uses the finding, not a second analysis of the profile', () => {
  const issue = {
    id: 'react-issue-1', summary: 'Expensive list work', severity: 'high',
    evidence: 'Own work in over-budget commits.',
    componentId: '1:4', component: 'ExpensiveList',
    commits: Array.from({length: 20}, (_, i) => ({ rootID: 1, commitIndex: i, timestampMs: i * 100, durationMs: 30 })),
  };
  assert.deepEqual(debugReactIssuePromptData(issue), {
    summary: 'Expensive list work', evidence: 'Own work in over-budget commits.',
    component: 'ExpensiveList', severity: 'high',
    commits: issue.commits.slice(0, 8).map(commit => ({ commitIndex: commit.commitIndex, durationMs: commit.durationMs })),
  });
  const oversized = debugReactIssuePromptData({ ...issue, summary: 'x'.repeat(100000), evidence: 'y'.repeat(100000) });
  assert.equal(oversized.summary.length, 2000);
  assert.equal(oversized.evidence.length, 2000);
  assert.equal(oversized.commits.length, 8);
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
    for (const data of [bottleneckPromptData(groups[0]), debugPromptData(hotspot)]) {
      const stack = data.functions[0].stack;
      assert.ok(stack.includes('getUserName (src/explore.tsx:42:7)'));
      assert.ok(stack.includes(handler));
      assert.ok(stack.indexOf('getUserName (src/explore.tsx:42:7)') < stack.indexOf(handler));
      assert.ok(stack.includes('toLocaleString'));
      assert.doesNotMatch(JSON.stringify(data), /https?:/);
      assert.equal(data.functions[0].stackIsRepresentative, true);
    }
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

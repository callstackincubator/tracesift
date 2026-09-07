import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisPromptData, bottleneckPromptData, debugPromptData, MAX_GROUP_PROMPT_BYTES } from '../src/lib/prompt-data.ts';

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

test('debug prompt context contains only the summary and shortlisted function names', () => {
  const hotspot = {
    ...largeGroup(), summary: 'Expensive formatting', suggestedFix: 'Investigate caching',
    supportingFunctionIds: ['b1-f0', 'b1-f7'],
  };
  assert.deepEqual(debugPromptData(hotspot), {
    summary: 'Expensive formatting', functions: ['function0', 'function7'],
  });
});

test('debug prompt context stays bounded even with oversized annotations and shortlists', () => {
  const hotspot = {
    ...largeGroup(), summary: 'x'.repeat(100000),
    supportingFunctionIds: Array.from({length: 10000}, (_, i) => `b1-f${i}`),
  };
  const data = debugPromptData(hotspot);
  assert.equal(data.summary.length, 2000);
  assert.equal(data.functions.length, 8);
});

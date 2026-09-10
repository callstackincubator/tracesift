import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFromDurationTrace } from '../src/lib/hermes-duration-profile.ts';

const event = (ts, ph, name, args = {}) => ({
  ts, ph, name, pid: 10, tid: 20, cat: 'JavaScript', args,
});

test('converts a symbolicated Hermes B/E duration trace to a weighted CDP profile', () => {
  const profile = extractFromDurationTrace([
    event(1_000, 'B', '[root]', { category: 'root', url: null }),
    event(2_000, 'B', 'dispatchEvent', { url: '/app.js', line: 10, column: 4 }),
    event(3_000, 'B', 'expensiveWork', { url: '/work.js', line: '25', column: '2' }),
    event(23_000, 'E', 'expensiveWork'),
    event(33_000, 'E', 'dispatchEvent'),
    event(41_000, 'E', '[root]'),
  ]);
  assert.ok(profile);

  assert.equal(profile.startTime, 1_000);
  assert.equal(profile.endTime, 41_000);
  assert.deepEqual(profile.samples, [1, 2, 3, 2, 1]);
  assert.deepEqual(profile.timeDeltas, [1_000, 1_000, 20_000, 10_000, 8_000]);
  assert.deepEqual(profile.nodes.map(({ id, parentId, callFrame }) => ({
    id, parentId, name: callFrame.functionName, url: callFrame.url,
    line: callFrame.lineNumber, column: callFrame.columnNumber,
  })), [
    { id: 1, parentId: undefined, name: '(root)', url: '', line: -1, column: -1 },
    { id: 2, parentId: 1, name: 'dispatchEvent', url: '/app.js', line: 9, column: 4 },
    { id: 3, parentId: 2, name: 'expensiveWork', url: '/work.js', line: 24, column: 2 },
  ]);
});

test('selects the Hermes thread containing the most measured work', () => {
  const profile = extractFromDurationTrace([
    event(0, 'B', 'short'), event(1_000, 'E', 'short'),
    { ...event(0, 'B', 'long'), tid: 21 },
    { ...event(10_000, 'E', 'long'), tid: 21 },
  ]);
  assert.ok(profile);
  assert.equal(profile.nodes[0].callFrame.functionName, 'long');
  assert.deepEqual(profile.timeDeltas, [10_000]);
});

test('does not mistake an incomplete duration event for a measurable profile', () => {
  assert.equal(extractFromDurationTrace([event(1_000, 'B', '[root]')]), null);
});

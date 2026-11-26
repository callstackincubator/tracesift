import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTraceryProfile, traceryToCpuProfile } from '../src/hermes-profile.js';
import { cpuProfileToTraceEvents } from '../src/record-rn-session.js';

const BUNDLE = 'index.android.bundle';

/**
 * A Tracery profile the way Hermes actually writes one: frame ids are decimal
 * string keys, `parent` and `sf` are numbers, `ts` is a string of microseconds
 * on a steady clock, and a release bundle's JS frames carry `funcVirtAddr` and
 * `offset` instead of a line, a column or a url.
 */
function tracery({ samples } = {}) {
  return {
    traceEvents: [
      { name: 'process_name', ph: 'M', cat: '__metadata', pid: 999, ts: '81000', tid: '-1', args: { name: 'hermes' } },
    ],
    samples: samples ?? [
      { cpu: '-1', name: '', ts: '81000', pid: 999, tid: '7', weight: '1', sf: 3 },
      { cpu: '-1', name: '', ts: '81100', pid: 999, tid: '7', weight: '1', sf: 4 },
      { cpu: '-1', name: '', ts: '81350', pid: 999, tid: '7', weight: '1', sf: 3 },
    ],
    stackFrames: {
      1: { name: '[root]', category: 'root' },
      2: { name: 'global', category: 'JavaScript', parent: 1, funcVirtAddr: '100', offset: '0' },
      3: { name: 'fibonacci', category: 'JavaScript', parent: 2, funcVirtAddr: '2048', offset: '17' },
      4: { name: '[Native] Array.prototype.sort', category: 'Native', parent: 2 },
      5: { name: '[GC Young Gen]', category: 'Metadata', parent: 1 },
    },
  };
}

test('parseTraceryProfile explains an empty dump rather than failing to parse', () => {
  assert.throws(() => parseTraceryProfile(''), /no runtime has the sampling profiler registered/);
  assert.throws(() => parseTraceryProfile('   '), /no runtime has the sampling profiler registered/);
});

test('parseTraceryProfile rejects non-JSON and non-objects', () => {
  assert.throws(() => parseTraceryProfile('not json'), /is not JSON/);
  assert.throws(() => parseTraceryProfile('[1,2]'), /not a Hermes sampling profile/);
});

test('traceryToCpuProfile carries the whole frame table with the root first', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });

  assert.equal(profile.nodes[0].id, 1);
  assert.equal(profile.nodes[0].callFrame.functionName, '(root)');
  assert.equal(profile.nodes[0].parent, undefined, 'the root is the node with no parent');
  assert.deepEqual(profile.nodes.map((node) => node.id), [1, 2, 3, 4, 5]);
  // Frames reachable from no sample are kept: the tree is shared between
  // threads and dropping them would break the parent walk.
  assert.ok(profile.nodes.some((node) => node.id === 5));
});

test('traceryToCpuProfile reads string ids and keeps the parent chain as numbers', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));

  assert.equal(typeof byId.get(3).id, 'number');
  assert.equal(byId.get(3).parent, 2);
  assert.equal(byId.get(2).parent, 1);

  // Leaf to root, which is how the stack is reconstructed.
  const walk = [];
  for (let id = 3; id !== undefined; id = byId.get(id)?.parent) walk.push(id);
  assert.deepEqual(walk, [3, 2, 1]);
});

test('traceryToCpuProfile folds funcVirtAddr and offset into a zero-based column on line 0', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });
  const fib = profile.nodes.find((node) => node.callFrame.functionName === 'fibonacci');

  assert.equal(fib.callFrame.url, BUNDLE, 'the url is stamped, because Tracery emits none');
  assert.equal(fib.callFrame.lineNumber, 0);
  assert.equal(fib.callFrame.columnNumber, 2048 + 17);
  assert.equal(fib.callFrame.scriptId, '1');
});

test('traceryToCpuProfile leaves native, host and GC frames unlocated', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });
  const native = profile.nodes.find((node) => node.id === 4);
  const gc = profile.nodes.find((node) => node.id === 5);

  assert.equal(native.callFrame.functionName, '[Native] Array.prototype.sort');
  assert.equal(native.callFrame.url, '');
  assert.equal(native.callFrame.lineNumber, -1);
  assert.equal(gc.callFrame.functionName, '[GC Young Gen]');
  assert.equal(gc.callFrame.url, '');
});

test('traceryToCpuProfile uses the location Hermes bakes into a name when debug info exists', () => {
  const raw = tracery();
  raw.stackFrames[3] = {
    name: 'fibonacci(src/App.tsx:12:5)', category: 'JavaScript', parent: 2, line: '12', column: '5',
  };
  const profile = traceryToCpuProfile(raw, { bundleUrl: BUNDLE });
  const fib = profile.nodes.find((node) => node.id === 3);

  assert.equal(fib.callFrame.functionName, 'fibonacci');
  assert.equal(fib.callFrame.url, 'src/App.tsx');
  assert.equal(fib.callFrame.lineNumber, 11, 'Hermes is one-based, CDP is zero-based');
  assert.equal(fib.callFrame.columnNumber, 4);
});

test('traceryToCpuProfile turns steady-clock timestamps into microsecond deltas', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });

  assert.equal(profile.startTime, 81000);
  assert.deepEqual(profile.samples, [3, 4, 3]);
  assert.deepEqual(profile.timeDeltas, [0, 100, 250]);
  assert.equal(profile.timeDeltas.length, profile.samples.length, 'deltas are index-parallel to samples');
});

test('traceryToCpuProfile keeps only the busiest thread', () => {
  const profile = traceryToCpuProfile(tracery({
    samples: [
      { ts: '1000', tid: '7', sf: 3 },
      { ts: '1100', tid: '9', sf: 4 },
      { ts: '1200', tid: '7', sf: 3 },
      { ts: '1300', tid: '7', sf: 2 },
    ],
  }), { bundleUrl: BUNDLE });

  assert.deepEqual(profile.samples, [3, 3, 2]);
  assert.deepEqual(profile.timeDeltas, [0, 200, 100]);
});

test('traceryToCpuProfile explains a profile with nothing in it', () => {
  assert.throws(() => traceryToCpuProfile({ samples: [], stackFrames: {} }), /no samples/);
  assert.throws(() => traceryToCpuProfile({ samples: [{ ts: '1', tid: '1', sf: 1 }] }), /no stackFrames or samples/);
  assert.throws(
    () => traceryToCpuProfile({ samples: [{ ts: 'x', tid: '1', sf: 'y' }], stackFrames: { 1: { name: '[root]', category: 'root' } } }),
    /no usable stack frame ids/,
  );
});

test('the converted profile survives cpuProfileToTraceEvents into Profile and ProfileChunk', () => {
  const profile = traceryToCpuProfile(parseTraceryProfile(JSON.stringify(tracery())), { bundleUrl: BUNDLE });
  const events = cpuProfileToTraceEvents(profile);

  assert.equal(events[0].name, 'Profile');
  assert.equal(events[0].args.data.startTime, 81000);
  assert.equal(events[1].name, 'ProfileChunk');
  assert.equal(events[1].args.data.cpuProfile.nodes.length, 5, 'the node table rides in the first chunk');
  assert.deepEqual(events[1].args.data.cpuProfile.samples, [3, 4, 3]);
  assert.deepEqual(events[1].args.data.timeDeltas, [0, 100, 250]);
});

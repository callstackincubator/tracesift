import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFromDurationTrace } from '../src/lib/hermes-duration-profile.ts';
import { coerceCdpProfile } from '../src/lib/js-profile.ts';

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


const frame = (name) => ({ functionName: name, scriptId: '1', url: name === '(idle)' ? '' : 'app.js', lineNumber: 0, columnNumber: 0 });

/**
 * One CPU profile inside a Chrome trace, as the tracer spells it: a `Profile`
 * carrying the start time on the profiled thread, then a `ProfileChunk` on the
 * sampler thread carrying the nodes and samples.
 */
const tracedProfile = ({ pid, id, tid, samples }) => [
  { name: 'Profile', ph: 'P', id, pid, tid, ts: 100, args: { data: { startTime: 100 } } },
  {
    name: 'ProfileChunk', ph: 'P', id, pid, tid: tid + 1, ts: 100,
    args: {
      data: {
        timeDeltas: samples.map(() => 1000),
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: frame('(root)'), children: [2, 3] },
            { id: 2, callFrame: frame('handlePress') },
            { id: 3, callFrame: frame('(idle)') },
          ],
          samples,
        },
      },
    },
  },
];

test('the busiest profile in a multi-thread trace wins, not the one with the most samples', () => {
  // A trace records every thread that was running. A service worker parked on
  // its message loop samples steadily and does nothing: on the local Chrome
  // trace it produced 100,200 samples against the renderer's 60,165, five of
  // which were not idle. Ranking on sample count alone handed the analysis that
  // profile and the whole page came back as a dozen tasks of 2 ms and under.
  const traceEvents = [
    ...tracedProfile({ pid: 2, id: '0x2', tid: 50, samples: Array(20).fill(3) }),
    ...tracedProfile({ pid: 1, id: '0x1', tid: 10, samples: [2, 2, 2, 3] }),
  ];
  const profile = coerceCdpProfile({ traceEvents });
  // Four samples, not twenty: the renderer's profile was chosen.
  assert.equal(profile.samples.length, 4);
  assert.deepEqual(profile.samples, [2, 2, 2, 3]);
});

test('a profile that never left idle does not beat an empty field', () => {
  // Nothing else to pick, so the idle profile is still returned rather than the
  // upload failing — an analysis that says the thread was idle is a finding.
  const profile = coerceCdpProfile({
    traceEvents: tracedProfile({ pid: 2, id: '0x2', tid: 50, samples: [3, 3, 3] }),
  });
  assert.equal(profile.samples.length, 3);
});

/**
 * The same two profiles, except the idle thread's samples land on a frame
 * *under* `(idle)` rather than on `(idle)` itself.
 *
 * V8 emits `(idle)` childless, so no recording to hand is shaped like this. It
 * is here because the rule used to be local to this module and tested the
 * sampled frame's own name, which made these samples active here and idle in
 * every module downstream — and nothing in the suite would have noticed.
 */
const idleWithChildren = ({ pid, id, tid, samples }) => [
  { name: 'Profile', ph: 'P', id, pid, tid, ts: 100, args: { data: { startTime: 100 } } },
  {
    name: 'ProfileChunk', ph: 'P', id, pid, tid: tid + 1, ts: 100,
    args: {
      data: {
        timeDeltas: samples.map(() => 1000),
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: frame('(root)'), children: [2, 3] },
            { id: 2, callFrame: frame('handlePress') },
            { id: 3, callFrame: frame('(idle)'), children: [4] },
            { id: 4, callFrame: frame('pollForWork') },
          ],
          samples,
        },
      },
    },
  },
];

test('a sample under an idle frame is idle here too, not just downstream', () => {
  const traceEvents = [
    ...idleWithChildren({ pid: 2, id: '0x2', tid: 50, samples: Array(20).fill(4) }),
    ...idleWithChildren({ pid: 1, id: '0x1', tid: 10, samples: [2, 2, 2, 3] }),
  ];
  const profile = coerceCdpProfile({ traceEvents });
  // Three real samples beat twenty parked under `(idle)`.
  assert.deepEqual(profile.samples, [2, 2, 2, 3]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCaptureWarnings, collectRetainedSourceMaps, symbolicateProfile } from '../src/lib/symbolicate.ts';
import { ruleClassTable } from '../src/lib/frame-classes.ts';
import { frameNameTier } from '../src/lib/frame-names.ts';

const BUNDLE = 'http://192.168.1.5:8081/index.bundle//&platform=ios&dev=true';

/**
 * Three generated lines, one per source. Hand-encoded rather than generated so
 * the test states the mapping it is asserting: `AAAA` is the first line at
 * source 0, and each following segment carries its deltas.
 */
const sourceMap = {
  version: 3,
  sources: [
    '/app/src/screens/Home.tsx',
    '/app/node_modules/react-native/Libraries/Pressability/Pressability.js',
    '/app/node_modules/react-dom/cjs/react-dom-client.development.js',
  ],
  names: [],
  mappings: 'AAAA;ACUI;ACLF',
};

const node = (id, functionName, lineNumber) => ({
  id,
  callFrame: { functionName, scriptId: '1', url: BUNDLE, lineNumber, columnNumber: 0 },
});

const profile = () => ({
  nodes: [
    node(1, 'HomeScreen', 0),
    node(2, 'onResponderRelease', 1),
    node(3, 'react_stack_bottom_frame', 2),
  ],
  startTime: 0,
  endTime: 1000,
  samples: [1, 2, 3],
  timeDeltas: [0, 100, 100],
});

const maps = [{ url: BUNDLE, sourceMapUrl: 'http://127.0.0.1:8081/index.map', sourceMap }];

test('the maps an enriched export carries are read back off its metadata', () => {
  assert.deepEqual(collectRetainedSourceMaps({ metadata: { sourceMaps: maps } }), maps);
  // A bare .cpuprofile, or a DevTools export, carries none. Not a failure.
  assert.deepEqual(collectRetainedSourceMaps({ metadata: { source: 'DevTools' } }), []);
  assert.deepEqual(collectRetainedSourceMaps(null), []);
});

test('Metro frames move from one bundle URL onto the files they were written in', () => {
  const parsed = profile();
  const info = symbolicateProfile(parsed, maps);

  assert.equal(info.state, 'full');
  assert.equal(info.symbolicatedFrameCount, 3);
  assert.equal(info.totalMappableFrameCount, 3);
  assert.deepEqual(info.failures, []);

  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.url), [
    '/app/src/screens/Home.tsx',
    '/app/node_modules/react-native/Libraries/Pressability/Pressability.js',
    '/app/node_modules/react-dom/cjs/react-dom-client.development.js',
  ]);
  // CDP counts lines from zero and a source map from one, so a frame recorded
  // at bundle line 1 and mapped to original line 11 comes back as 10.
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.lineNumber), [0, 10, 5]);
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.columnNumber), [0, 4, 2]);
});

test('the bundle position is kept, because it is what was actually sampled', () => {
  const parsed = profile();
  symbolicateProfile(parsed, maps);
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.bundleUrl), [BUNDLE, BUNDLE, BUNDLE]);
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.bundleLineNumber), [0, 1, 2]);
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.bundleColumnNumber), [0, 0, 0]);
});

test('a bundle URL recorded with different build options still finds its map', () => {
  const parsed = profile();
  for (const n of parsed.nodes) n.callFrame.url = 'http://192.168.1.5:8081/index.bundle//&platform=ios&dev=false&minify=true';
  const info = symbolicateProfile(parsed, maps);
  assert.equal(info.symbolicatedFrameCount, 3);
});

test('a recording with no retained maps is left exactly as it was', () => {
  const parsed = profile();
  const info = symbolicateProfile(parsed, []);
  assert.equal(info.state, 'none');
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.url), [BUNDLE, BUNDLE, BUNDLE]);
  assert.equal(parsed.nodes[0].callFrame.bundleUrl, undefined);
});

test('an unreadable map is reported rather than thrown', () => {
  const parsed = profile();
  const info = symbolicateProfile(parsed, [{ url: BUNDLE, sourceMapUrl: 'x.map', sourceMap: { version: 3 } }]);
  assert.equal(info.state, 'failed');
  assert.equal(info.failures.length, 1);
  assert.equal(info.failures[0].bundleUrl, BUNDLE);
  assert.deepEqual(parsed.nodes.map((n) => n.callFrame.url), [BUNDLE, BUNDLE, BUNDLE]);
});

test('this is what makes a React Native profile classifiable at all', () => {
  const before = profile();
  const unmapped = ruleClassTable(before.nodes.map((n) => n.callFrame));
  // Every frame shares one `index.bundle`, so no rule can place any of them and
  // all three fall to the `library` fallback — including React's own internals,
  // which is why an internal with an ordinary name ends up heading a card.
  assert.deepEqual(before.nodes.map((n) => unmapped.classOf(n.callFrame)), ['library', 'library', 'library']);
  assert.equal(unmapped.degraded, true);
  assert.equal(frameNameTier(before.nodes[2].callFrame), 2);

  const after = profile();
  symbolicateProfile(after, maps);
  const mapped = ruleClassTable(after.nodes.map((n) => n.callFrame));
  assert.deepEqual(after.nodes.map((n) => mapped.classOf(n.callFrame)), ['app', 'library', 'framework']);
  assert.equal(mapped.degraded, false);
});

test('a capture that could not retain a map says so in the export it wrote', () => {
  // `record.json` carries these too, and the next recording overwrites it. By
  // the time someone opens an export and finds every frame still at a bundle
  // position, this is the only place the reason survives.
  const warnings = collectCaptureWarnings({
    metadata: {
      sourceMaps: [],
      traceSift: {
        warnings: [
          'Could not retain the Metro source map http://127.0.0.1:8081/index.ts.map//&platform=ios after 30s: The operation was aborted due to timeout',
          42,
        ],
      },
    },
  });
  assert.deepEqual(warnings, [
    'Could not retain the Metro source map http://127.0.0.1:8081/index.ts.map//&platform=ios after 30s: The operation was aborted due to timeout',
  ]);
});

test('a profile that was never enriched is not a profile whose enrichment failed', () => {
  assert.deepEqual(collectCaptureWarnings({ metadata: { sourceMaps: [] } }), []);
  assert.deepEqual(collectCaptureWarnings(null), []);
  // And the distinction reaches the caller: both report `state: "none"`, only
  // one of them can say why.
  const failed = symbolicateProfile(profile(), [], ['Metro timed out']);
  assert.equal(failed.state, 'none');
  assert.deepEqual(failed.captureWarnings, ['Metro timed out']);
  assert.deepEqual(symbolicateProfile(profile(), []).captureWarnings, []);
});

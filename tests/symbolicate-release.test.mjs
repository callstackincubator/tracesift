import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { coerceCdpProfile } from '../src/lib/js-profile.ts';
import { collectRetainedSourceMaps, symbolicateProfile } from '../src/lib/symbolicate.ts';

/** A real release capture: 30,875 samples taken from a Hermes release build of an Expo app on a
 * physical iPhone, with the map `profile build` left beside it. */
const FIXTURE = new URL('../test-fixtures/release-ios/trace.json.gz', import.meta.url);

function load() {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)));
  const profile = coerceCdpProfile(raw);
  const info = symbolicateProfile(profile, collectRetainedSourceMaps(raw));
  const selfSamples = new Map();
  for (const id of profile.samples) selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);
  return { profile, info, selfSamples };
}

/** The node for `name` at 1-based `line` of `file`, with the samples it ran for. */
function find({ profile, selfSamples }, name, file, line) {
  const node = profile.nodes.find(({ callFrame: f }) => f.functionName === name && f.url.endsWith(`/${file}`) && f.lineNumber + 1 === line);
  assert.ok(node, `no frame ${name} at ${file}:${line}`);
  return { frame: node.callFrame, samples: selfSamples.get(node.id) ?? 0 };
}

test('a release capture resolves to the app\'s own functions and files', () => {
  const run = load();
  assert.equal(run.profile.samples.length, 30875);

  const heatmap = find(run, 'HeavyActivityHeatmap', 'src/app/explore-details.tsx', 25);
  const spending = find(run, 'SpendingSummary', 'src/app/explore-list.tsx', 140);
  const leaderboard = find(run, 'MerchantLeaderboard', 'src/app/explore-list.tsx', 165);
  assert.deepEqual([heatmap.samples, spending.samples, leaderboard.samples], [69, 375, 544]);

  // Hermes reported a bytecode offset on line 1 of the bundle; that is kept.
  assert.equal(heatmap.frame.bundleUrl, 'main.jsbundle');
  assert.equal(heatmap.frame.bundleLineNumber, 0);
  assert.equal(heatmap.frame.bundleColumnNumber, 1146546);
});

test('React Native internals resolve to their packages, not the bundle', () => {
  const { profile } = load();
  const rn = profile.nodes.filter(({ callFrame: f }) => f.url.startsWith('/node_modules/react-native/'));
  assert.ok(rn.length > 1000, `only ${rn.length} react-native frames`);
  assert.ok(rn.some(({ callFrame: f }) => f.functionName === 'extractEvents' && f.url.endsWith('/ReactFabric-prod.js')));
});

test('partial is the two frames whose only mapping is a sourceless segment', () => {
  const { profile, info } = load();
  assert.equal(info.state, 'partial');
  assert.equal(info.totalMappableFrameCount, 1270);
  assert.equal(info.symbolicatedFrameCount, 1268);
  assert.deepEqual(info.failures, []);

  // Metro writes a generated-only segment where a module wrapper ends, so these
  // anonymous frames have no original position to give. They stay as offsets.
  const stillBundle = profile.nodes
    .filter(({ callFrame: f }) => f.url === 'main.jsbundle' && f.lineNumber >= 0)
    .map(({ callFrame: f }) => f.columnNumber)
    .sort((a, b) => a - b);
  assert.deepEqual(stillBundle, [448832, 449700]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHART_SLICES } from '../src/lib/contribution.ts';
import { reactCommitSlices } from '../src/lib/react-contribution.ts';
import { parseReactExport } from '../src/lib/react-commit-tree.ts';
import { buildReactCards } from '../src/lib/react-cards.ts';
import { buildExport } from './react-export-fixture.mjs';

const culprit = (component, selfMs, rest = {}) => ({
  componentId: `1:${component}`,
  component,
  componentClass: 'app',
  selfMs,
  percentOfCommit: 0,
  cause: 'first-mount',
  changedProps: [],
  changedHooks: [],
  compiledWithForget: false,
  sourceHint: null,
  path: ['Screen', component],
  evidence: '',
  ...rest,
});

const card = (durationMs, culprits, rest = {}) => ({
  durationMs,
  culprits,
  culpritTailCount: 0,
  culpritTailMs: 0,
  unattributedMs: 0,
  ...rest,
});

const shareSum = (slices) => slices.reduce((sum, slice) => sum + slice.share, 0);

test('the commit divides into its components, the smaller ones, and the reconciler', () => {
  const slices = reactCommitSlices(card(
    1000,
    [culprit('MerchantLeaderboard', 520), culprit('SpendingSummary', 370)],
    { culpritTailCount: 12, culpritTailMs: 60, unattributedMs: 50 },
  ));

  assert.deepEqual(slices.map((slice) => slice.kind), ['component', 'component', 'tail', 'outside']);
  assert.deepEqual(slices.map((slice) => slice.name), [
    'MerchantLeaderboard', 'SpendingSummary', '12 smaller components', 'React itself, no component',
  ]);
  assert.deepEqual(slices.map((slice) => slice.ms), [520, 370, 60, 50]);
  assert.ok(Math.abs(shareSum(slices) - 1) < 1e-9, `shares summed to ${shareSum(slices)}`);
  // Only the components take a palette slot; the residuals are not series.
  assert.deepEqual(slices.map((slice) => slice.colorIndex), [0, 1, -1, -1]);
});

test('a commit a single component accounts for gets neither residual', () => {
  const slices = reactCommitSlices(card(170, [culprit('HeavyActivityHeatmap', 170)]));
  assert.deepEqual(slices.map((slice) => slice.kind), ['component']);
  assert.equal(slices[0].share, 1);
});

test('a component too thin to draw joins the tail it would otherwise hide behind', () => {
  const slices = reactCommitSlices(card(
    1000,
    [culprit('big', 600), culprit('sliver', 2), culprit('small', 200)],
    { culpritTailCount: 4, culpritTailMs: 100 },
  ));

  assert.deepEqual(slices.map((slice) => slice.name), ['big', 'small', '5 smaller components']);
  // `small` keeps slot 2 — the slot it holds in the ranking — rather than
  // sliding into the one the folded sliver vacated.
  assert.deepEqual(slices.map((slice) => slice.colorIndex), [0, 2, -1]);
  assert.equal(slices[2].ms, 102, 'the folded sliver is counted in the tail exactly once');
});

test('components past the palette are counted in the tail rather than drawn uncoloured', () => {
  const culprits = Array.from({ length: CHART_SLICES + 3 }, (_, index) => culprit(`Row${index}`, 50 - index));
  const slices = reactCommitSlices(card(1000, culprits, { unattributedMs: 200 }));

  assert.equal(slices.filter((slice) => slice.kind === 'component').length, CHART_SLICES);
  const tail = slices.find((slice) => slice.kind === 'tail');
  assert.equal(tail.tailCount, 3);
  assert.equal(tail.ms, 50 - 8 + (50 - 9) + (50 - 10));
  assert.ok(slices.every((slice) => slice.colorIndex < CHART_SLICES));
});

test('a commit with no measured duration has nothing to divide', () => {
  assert.deepEqual(reactCommitSlices(card(0, [culprit('Anything', 5)])), []);
});

test('the slices of a measured commit sum to the commit React reported', () => {
  const components = [
    { id: 2, name: 'ExploreListScreen(./explore.tsx)' },
    { id: 3, name: 'MerchantLeaderboard(./leaderboard.tsx)', parentId: 2 },
    { id: 4, name: 'SpendingSummary(./summary.tsx)', parentId: 2 },
    ...Array.from({ length: 30 }, (_, index) => ({ id: 100 + index, name: `Row${index}`, parentId: 3 })),
  ];
  const [recording] = parseReactExport(buildExport({
    components,
    commits: [{
      duration: 276,
      updaters: ['ExploreListScreen'],
      fibers: [[3, 142], [4, 101], [2, 1.2], ...Array.from({ length: 30 }, (_, index) => [100 + index, 0.2])],
    }],
  }));
  const [built] = buildReactCards([recording], 16).cards;
  const slices = reactCommitSlices(built);

  assert.deepEqual(slices.slice(0, 2).map((slice) => slice.name), ['MerchantLeaderboard', 'SpendingSummary']);
  const drawnMs = slices.reduce((sum, slice) => sum + slice.ms, 0);
  assert.ok(Math.abs(drawnMs - built.durationMs) < 0.5, `drew ${drawnMs} of a ${built.durationMs} ms commit`);
  assert.ok(Math.abs(shareSum(slices) - 1) < 1e-9, `shares summed to ${shareSum(slices)}`);
});

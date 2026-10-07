import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseReactExport, hookLabel } from '../src/lib/react-commit-tree.ts';
import { buildReactCards } from '../src/lib/react-cards.ts';
import { buildReactExplore, focusedReactTree } from '../src/lib/react-explore.ts';
import { buildExport } from './react-export-fixture.mjs';

/** Every node of a forest, depth first. */
function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function depthOf(node, depth = 0) {
  return Math.max(depth, ...node.children.map((child) => depthOf(child, depth + 1)));
}

function explore(raw, budget = 16) {
  const recordings = parseReactExport(raw);
  return buildReactExplore(recordings, buildReactCards(recordings, budget));
}

function commitAt(set, index) {
  return set.commits.find((commit) => commit.commitIndex === index);
}

test('a commit becomes a tree, not the flat list the card ranks', () => {
  const set = explore(buildExport({
    components: [
      { id: 2, name: 'Screen(./screen.tsx)' },
      { id: 3, name: 'Panel', parentId: 2 },
      { id: 4, name: 'Chart', parentId: 3 },
      { id: 5, name: 'Legend', parentId: 3 },
    ],
    commits: [{ duration: 40, fibers: [[2, 1], [3, 2], [4, 30], [5, 3]] }],
  }));
  const commit = commitAt(set, 0);
  assert.equal(commit.tree.length, 1, 'one update root');
  const [screen] = commit.tree;
  assert.equal(screen.name, 'Screen');
  assert.equal(screen.children.length, 1);
  const [panel] = screen.children;
  // Heaviest first, like every other ranking in the tool.
  assert.deepEqual(panel.children.map((child) => child.name), ['Chart', 'Legend']);
  assert.equal(flatten(commit.tree).length, 4);
});

test('a component whose parent did not render nests under the nearest one that did', () => {
  const set = explore(buildExport({
    components: [
      { id: 2, name: 'Screen' },
      { id: 3, name: 'MemoBoundary', parentId: 2 },
      { id: 4, name: 'Deep', parentId: 3 },
    ],
    // `MemoBoundary` bailed out, so React recorded no duration for it at all.
    commits: [{ duration: 40, fibers: [[2, 1], [4, 30]] }],
  }));
  const [screen] = commitAt(set, 0).tree;
  assert.equal(screen.name, 'Screen');
  assert.deepEqual(screen.children.map((child) => child.name), ['Deep'],
    'the gap in the middle is walked rather than flattening Deep onto the top row');
});

test('the strip carries every commit against the clock, over budget or not', () => {
  const set = explore(buildExport({
    components: [{ id: 2, name: 'Ticker(./ticker.tsx)' }, { id: 3, name: 'Price', parentId: 2 }],
    commits: [
      { duration: 2, timestamp: 100, updaters: ['Ticker'], fibers: [[2, 0.5], [3, 1]] },
      { duration: 40, timestamp: 150, updaters: ['Ticker'], fibers: [[2, 1], [3, 30]] },
      { duration: 3, timestamp: 400, updaters: ['Ticker'], fibers: [[2, 0.5], [3, 2]] },
    ],
  }));
  assert.equal(set.commits.length, 3, 'a commit under budget is still in the chart');
  assert.deepEqual(set.commits.map((commit) => commit.overBudget), [false, true, false]);
  assert.equal(set.commitsOverBudget, 1);
  assert.equal(set.commits[0].startMs, 100, 'commit timestamps stay raw');
  assert.equal(set.spanMs, 303, 'first commit start to last commit end');
  // Only the over-budget commit produced a card, and the chart says which.
  assert.deepEqual(set.commits.map((commit) => commit.cardId),
    [null, 'react-commit-1-1', null]);
  assert.equal(commitAt(set, 1).topComponent, 'Price');
  assert.equal(commitAt(set, 1).unattributedMs, 9, '40 ms commit, 31 ms reached a component');
});

test('collapsing the pass-throughs loses no time and no finding', () => {
  // A provider chain of the shape a React tree actually has: six wrappers with
  // a hundredth of a millisecond each, and the cost at the bottom.
  const wrappers = Array.from({ length: 6 }, (_, index) => ({
    id: 10 + index, name: `Context${index}.Provider`, parentId: index === 0 ? 2 : 9 + index,
  }));
  const set = explore(buildExport({
    components: [
      { id: 2, name: 'Screen(./screen.tsx)' },
      ...wrappers,
      { id: 20, name: 'Heatmap', parentId: 15 },
    ],
    commits: [{ duration: 40, fibers: [[2, 0.5], ...wrappers.map((w) => [w.id, 0.01]), [20, 35]] }],
  }));
  const commit = commitAt(set, 0);
  const before = flatten(commit.tree);
  assert.equal(before.length, 8);
  assert.equal(Math.max(...commit.tree.map((node) => depthOf(node))), 7);

  const focused = focusedReactTree(commit.tree);
  const after = flatten(focused.nodes);
  assert.deepEqual(after.map((node) => node.name), ['Screen', 'Heatmap'],
    'six providers that computed nothing and rendered one child each are gone');
  assert.equal(Math.max(...focused.nodes.map((node) => depthOf(node))), 1);

  const sum = (nodes) => nodes.reduce((total, node) => total + node.selfMs, 0);
  assert.equal(
    Math.round((sum(after) + focused.strippedMs) * 100) / 100,
    Math.round(sum(before) * 100) / 100,
    'every collapsed millisecond is charged to a component still shown',
  );
  assert.equal(after[0].selfMs, 0.56, "the chain's own time lands on the nearest kept ancestor");
});

test('a branch point survives the collapse however little it costs', () => {
  const set = explore(buildExport({
    components: [
      { id: 2, name: 'Screen' },
      { id: 3, name: 'Split', parentId: 2 },
      { id: 4, name: 'Left', parentId: 3 },
      { id: 5, name: 'Right', parentId: 3 },
    ],
    commits: [{ duration: 40, fibers: [[2, 0.01], [3, 0.01], [4, 20], [5, 15]] }],
  }));
  const focused = focusedReactTree(commitAt(set, 0).tree);
  assert.deepEqual(flatten(focused.nodes).map((node) => node.name), ['Split', 'Left', 'Right'],
    'Screen passed through and goes; Split is where the time divides and stays');
});

test('a commit with no per-component durations keeps its place and admits it has no tree', () => {
  const set = explore(buildExport({
    components: [{ id: 2, name: 'Screen' }],
    commits: [{ duration: 40, fibers: [[2, 30]] }, { duration: 0, timestamp: 50, fibers: [] }],
  }));
  assert.equal(set.commits.length, 2);
  assert.deepEqual(commitAt(set, 1).tree, []);
  assert.equal(commitAt(set, 1).treeDropped, false, 'nothing was dropped — React recorded nothing');
});

test('changed hooks are labelled as the indices they are', () => {
  assert.equal(hookLabel('1'), '#1');
  assert.equal(hookLabel('useWindowDimensions'), 'useWindowDimensions');
});

test('the bundled sample drills down to the component the card names', () => {
  const raw = JSON.parse(readFileSync('sample-profiles/react/react-profile-1.json', 'utf8'));
  const recordings = parseReactExport(raw);
  const cards = buildReactCards(recordings, 16);
  const set = buildReactExplore(recordings, cards);

  assert.equal(set.commits.length, 8);
  assert.equal(set.commitsOverBudget, 1);
  const commit = set.commits.find((entry) => entry.cardId === cards.cards[0].id);
  assert.equal(commit.durationMs, 275.7, 'the strip and the card measure the same commit');
  assert.equal(commit.renderedCount, 280);
  assert.equal(flatten(commit.tree).length, 280, 'every rendered fiber is in the tree');
  assert.equal(commit.tree.length, 1, 'one update root');

  // 110 rows of providers is what makes the unfiltered icicle unreadable.
  assert.equal(Math.max(...commit.tree.map((node) => depthOf(node))), 110);
  const focused = focusedReactTree(commit.tree);
  assert.ok(Math.max(...focused.nodes.map((node) => depthOf(node))) < 30, 'the collapse is what makes it readable');

  const hottest = flatten(focused.nodes).sort((a, b) => b.selfMs - a.selfMs)[0];
  assert.equal(hottest.name, 'MerchantLeaderboard');
  assert.equal(hottest.name, cards.cards[0].culprits[0].component);
  assert.equal(hottest.cause, 'first-mount');
  assert.ok(hottest.compiledWithForget);
});

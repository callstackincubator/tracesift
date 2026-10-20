import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { buildExport } from './react-export-fixture.mjs';

/**
 * The published shape of `@callstack/tracesift-explore`.
 *
 * The package exists so the Next route and the plugin panel draw the same
 * Explore from the same code, and a bundler with no Tailwind and no
 * patch-package has to be able to consume it. Those are the promises held here:
 * that the built package renders a hand-off, that it asks nothing a browser does
 * not have, and that the props a host is told about are the props the components
 * read.
 *
 * Every case below imports from `dist`, which is what a consumer resolves. A
 * checkout that has not built the package skips rather than fails — the sources
 * are still covered by the package's own `typecheck`, and the skip says so.
 */

const pkgRoot = new URL('../packages/explore/', import.meta.url);
const built = existsSync(new URL('dist/index.js', pkgRoot));
const needsBuild = built ? false : 'run `npm run build:explore` first';

const explore = built ? await import('@callstack/tracesift-explore') : null;

/** Every file under `dist`, so a scan covers declarations as well as code. */
function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** One measured 200 ms task, in the shape `selectTaskCards` reads. */
function taskHandoff() {
  const node = (id, name, children = [], url = 'app.js', line = 0) => ({
    id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
  });
  const nodes = [
    node(0, '(root)', [1], ''),
    node(1, 'performWorkOnRoot', [2], 'node_modules/react-dom/index.js'),
    node(2, 'Search_Search', [3], 'src/screens/Search.tsx', 11),
    node(3, 'applyMerge', [4], 'src/screens/merge.ts', 4),
    node(4, 'toLocaleString', [], 'native date.js'),
  ];
  const samples = Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 3 : 4));
  const profile = explore.attachMeasuredTasks(
    { nodes, samples, timeDeltas: samples.map(() => 1000), startTime: 0, endTime: 200_000 },
    [{ ts: 0, dur: 200_000 }],
  );
  const { cards } = explore.selectTaskCards(profile, 200, explore.extractTasks(profile), explore.ruleClassTable());
  return { analysisId: 'fixture', totalMs: 200, profileTitle: 'fixture.cpuprofile', card: cards[0] };
}

/** A recording with one wide commit and one small one, as DevTools exported it. */
function reactHandoff() {
  const raw = buildExport({
    components: [
      { id: 2, name: 'Screen(./screen.tsx)' },
      { id: 3, name: 'Panel', parentId: 2 },
      { id: 4, name: 'Chart', parentId: 3 },
      { id: 5, name: 'Legend', parentId: 3 },
    ],
    commits: [
      { duration: 40, fibers: [[2, 1], [3, 2], [4, 30], [5, 3]], updaters: ['Screen'] },
      { duration: 8, fibers: [[2, 1], [5, 6]], updaters: ['Screen'] },
    ],
  });
  const recordings = explore.parseReactExport(raw);
  const cards = explore.buildReactCards(recordings, 16);
  return { analysisId: 'fixture', explore: explore.buildReactExplore(recordings, cards), cards: cards.cards };
}

/**
 * The legacy `?c=` mode's payload: one node-descent card and its subtree.
 *
 * Built by the app's own `selectCards` rather than by hand, because that is who
 * writes this hand-off — and the views are the package's, so a card produced on
 * one side of the boundary and drawn on the other is the compatibility the app
 * depends on.
 */
async function cardHandoff() {
  const { buildCallTree } = await import('../src/lib/call-tree.ts');
  const { selectCards } = await import('../src/lib/profile-cards.ts');
  const node = (id, name, children = [], url = 'src/app.ts', line = 0) => ({
    id, children, callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
  });
  const nodes = [
    node(0, '(root)', [1, 9], ''),
    node(1, 'onPressSubmit', [2]),
    node(2, 'buildReport', [3, 4]),
    node(3, 'getTotal', [5]),
    node(4, 'renderRow', [6]),
    node(5, 'format', [], 'fmt.js', 11),
    node(6, 'format', [], 'fmt.js', 11),
    node(9, 'backgroundWork', [], 'bg.js'),
  ];
  const samples = Array.from({ length: 60 }, () => [2, 2, 3, 5, 5, 5, 4, 6, 6, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]).flat();
  const selection = selectCards(buildCallTree({ nodes, samples, startTime: 0, endTime: 1 }, 2000));
  const card = selection.cards.find((entry) => entry.title === 'buildReport');
  assert.ok(card, 'the fixture produces a card to drill into');
  return {
    analysisId: 'fixture',
    totalMs: selection.durationMs,
    callCountIsExact: selection.callCountIsExact,
    card,
  };
}

test('the built package is there to be imported', () => {
  // `prepare` builds this during `npm install`, so the way to arrive unbuilt is
  // an install with `--ignore-scripts`. The rest of the file skips on a missing
  // build; this one is the named check that the build is expected at all.
  assert.ok(built, 'the Explore package has no dist: `npm install` builds it, or run `npm run build:explore`');
});

test('what a host hands over arrives as plain data', { skip: needsBuild }, () => {
  const handoff = taskHandoff();
  assert.equal(typeof handoff.card.tree.id, 'string');
  assert.ok(handoff.card.timeline.boxes.length > 0, 'the timeline has something to draw');
  assert.ok(handoff.card.culprits.length > 0, 'the culprit table has something to list');
  // A task card is fetched and parsed, so a hand-off is whatever `JSON.parse`
  // leaves behind — no class instances, no functions. The views render the same
  // page either way, which is the promise the round trip is worth testing.
  const parsed = JSON.parse(JSON.stringify(handoff));
  assert.equal(
    renderToString(createElement(explore.TaskExplorer, { handoff: parsed })),
    renderToString(createElement(explore.TaskExplorer, { handoff })),
  );

  const react = reactHandoff();
  assert.equal(react.explore.commits.length, 2);
  assert.equal(react.explore.commits[0].tree[0].name, 'Screen');
  assert.deepEqual(JSON.parse(JSON.stringify(react.explore)), react.explore);
});

test('the task drill-down renders a hand-off to markup', { skip: needsBuild }, () => {
  const html = renderToString(createElement(explore.TaskExplorer, { handoff: taskHandoff() }));
  assert.match(html, /class="explore-header"/);
  assert.match(html, /Search_Search/, 'the headline names the frame the task entered');
  assert.match(html, /class="timeline-box/, 'the timeline drew its boxes');
  assert.match(html, /Views of this task/, 'all four tabs are there');
  assert.match(html, /200 ms/, 'the figures are the measured ones');
});

test('the React drill-down renders a recording to markup', { skip: needsBuild }, () => {
  const html = renderToString(createElement(explore.ReactExplorer, { handoff: reactHandoff() }));
  assert.match(html, /class="commit-slot"/, 'the strip drew a bar for the commit');
  assert.match(html, /Views of this commit/);
  assert.match(html, /<strong>40 ms<\/strong> rendering/);
});

test('the views take their focus and commit from the host', { skip: needsBuild }, () => {
  // `renderToString` runs with no `window`, no `location` and no storage at all.
  // A view that reached for any of them would throw here rather than fail
  // quietly inside a plugin iframe, which is the whole point of props-in.
  const handoff = taskHandoff();
  assert.ok(renderToString(createElement(explore.TaskExplorer, { handoff })).length > 1000);
  assert.ok(renderToString(createElement(explore.ReactExplorer, { handoff: reactHandoff() })).length > 1000);

  // An id the host names wins over the card's root, and the one way back out
  // appears with it: the view is following the host rather than its own default.
  const focused = handoff.card.tree.children[0];
  assert.ok(focused, 'the fixture has a frame to focus on');
  const focusedHtml = renderToString(createElement(explore.TaskExplorer, { handoff, focusNodeId: focused.id }));
  assert.match(focusedHtml, /Leave the focused frame/);
  assert.doesNotMatch(renderToString(createElement(explore.TaskExplorer, { handoff })), /Leave the focused frame/,
    'with no focus named, the whole task is open');

  const react = reactHandoff();
  const [commit] = react.explore.commits;
  assert.match(
    renderToString(createElement(explore.ReactExplorer, { handoff: react, commitKey: `${commit.rootId}.${commit.commitIndex}` })),
    /aria-pressed="true"/,
    'the commit the host named is the one held down',
  );
  // A key this recording does not contain falls back to the longest commit
  // rather than opening on nothing.
  assert.match(
    renderToString(createElement(explore.ReactExplorer, { handoff: react, commitKey: '9.9' })),
    /class="commit-slot"/,
  );
});

test('ExploreView routes the hand-off it was given', { skip: needsBuild }, async () => {
  assert.match(renderToString(createElement(explore.ExploreView, { task: { state: 'loading' } })), /Loading this task/);
  assert.match(
    renderToString(createElement(explore.ExploreView, { task: { state: 'failed', reason: 'No such analysis.' } })),
    /No such analysis\./,
  );

  const none = renderToString(createElement(explore.ExploreView, {}));
  assert.match(none, /Nothing to explore/);
  assert.doesNotMatch(none, /explore-footer/, 'a host that cannot close offers no Close button');
  assert.match(renderToString(createElement(explore.ExploreView, { onClose: () => {} })), /class="explore-footer"/);

  const task = renderToString(createElement(explore.ExploreView, { task: { state: 'ready', handoff: taskHandoff() } }));
  assert.match(task, /class="explore-page"/);
  assert.match(task, /Views of this task/);

  const react = renderToString(createElement(explore.ExploreView, { react: { state: 'ready', handoff: reactHandoff() } }));
  assert.match(react, /Views of this commit/);

  const card = renderToString(createElement(explore.ExploreView, { card: await cardHandoff() }));
  assert.match(card, /Views of this subtree/, 'the legacy card mode is a hand-off like any other');
  assert.match(card, /Repeated work/);
});

test('a host that passes a selection gets picking in the views it renders', { skip: needsBuild }, () => {
  // Selection is the plugin panel's affordance, so the promise held here is the
  // published one: one set of node ids rings the frames, the pick is numbered in
  // the order it was chosen, and a host that passes nothing sees the views it
  // always saw. Clicking is the panel's own test; this is the shape of the seam.
  const handoff = taskHandoff();
  const tree = handoff.card.tree;
  const picked = tree.children[0];
  assert.ok(picked && picked.children.length > 0, 'the fixture nests at least one frame');
  const inner = picked.children[0];

  const selectedNodeIds = [picked.id, inner.id];
  const render = (enabled) => renderToString(createElement(explore.TaskExplorer, {
    handoff,
    selection: { enabled, selectedNodeIds, onToggleSelection: () => {} },
  }));
  const html = render(true);
  assert.match(html, /class="[^"]*is-picked/, 'the picked frame carries the pick class');
  assert.match(html, /class="explore-picked-tick/, 'and the pill that says which pick it is');
  assert.match(html, /aria-pressed="true"/, 'a picked thing reports that it is pressed');

  // Turning the host's switch off changes what a click does and nothing else. The
  // two renders differ elsewhere — the switch's own note, `aria-pressed` — so what
  // is compared is the picked markup itself: a reader who stops picking has not
  // un-picked anything, and the set they counted off the screen is still drawn.
  const picks = (markup) => [
    markup.split('is-picked').length - 1,
    markup.split('explore-picked-tick').length - 1,
  ];
  assert.deepEqual(picks(render(false)), picks(html),
    'the same frames are ringed and numbered with the switch off');
  assert.ok(picks(html)[0] > 0, 'and the check above has something to compare');

  // The host that does not ask for picking gets no trace of it. This is the Next
  // app's call, and it is the regression this whole prop must not become.
  const plain = renderToString(createElement(explore.TaskExplorer, { handoff }));
  assert.doesNotMatch(plain, /is-picked|explore-picked-tick/, 'no selection, no pick drawing');

  // The synthetic root is a join point and not a frame, so it is never a pick —
  // it would otherwise be the largest clickable box in two of the four views.
  assert.equal(explore.isPickableName(tree.name), false, 'the root names nothing pickable');
  assert.equal(explore.isPickableName(picked.name), true);
  assert.equal(explore.pickNumber({ enabled: true, selectedNodeIds: [inner.id, picked.id], onToggleSelection: () => {} }, picked.id), 2,
    'the number is the order the reader chose in, not the tree order');
  assert.equal(explore.pickNumber({ enabled: true, selectedNodeIds: [picked.id], onToggleSelection: () => {} }, 'no-such-frame'), undefined);
});

test('one pick of a function rings every box the flame graph draws of it', { skip: needsBuild }, () => {
  // The timeline draws one box per call and the merged tree one node per call
  // site, so a frame called eight times is eight rings on the chart and one in
  // the graph — which reads as a pick that failed to take. The graph therefore
  // rings by the frame, not the node. A tree the fixture does not happen to
  // contain, so it is written here: one function reached by two paths.
  const leaf = (id, name, selfMs) => ({
    id, name, frameClass: 'app', totalMs: selfMs, selfMs, invocations: 1, children: [],
    ...(name === 'applyMerge' ? { location: 'src/merge.ts:4' } : {}),
  });
  const tree = {
    id: '0', name: '(root)', frameClass: 'app', totalMs: 100, selfMs: 0, invocations: 1,
    children: [
      {
        id: '0.0', name: 'renderA', frameClass: 'app', totalMs: 60, selfMs: 10, invocations: 1,
        children: [leaf('0.0.0', 'applyMerge', 50)],
      },
      {
        id: '0.1', name: 'renderB', frameClass: 'app', totalMs: 40, selfMs: 10, invocations: 1,
        children: [leaf('0.1.0', 'applyMerge', 30)],
      },
    ],
  };
  const picksOf = (...selectedNodeIds) =>
    explore.pickedFlamePicks(tree, tree, { enabled: true, selectedNodeIds, onToggleSelection: () => {} });

  // Picked on one path, both boxes show the pick.
  const one = picksOf('0.1.0');
  assert.deepEqual(one.labels, { '0.0.0': '1', '0.1.0': '1' },
    'the copy nobody clicked carries the same ring and the same number');
  // The second click on either copy is the take-it-out of the pick that exists —
  // a box that only borrows a ring has an id nobody chose, and toggling it would
  // otherwise start a second pick of the function the reader just removed.
  assert.equal(one.ownerOf('0.0.0'), '0.1.0', 'a borrowed ring toggles the pick it shows');
  assert.equal(one.ownerOf('0.1.0'), '0.1.0');
  assert.equal(one.ownerOf('0.0'), '0.0', 'an unpicked box stays its own');

  // Two picks of the same function stay two picks, each box numbered as the one
  // it is, because they are separate call sites and the hand-off says so.
  const both = picksOf('0.1.0', '0.0.0');
  assert.deepEqual(both.labels, { '0.0.0': '2', '0.1.0': '1' });
  assert.equal(both.ownerOf('0.0.0'), '0.0.0');
  assert.equal(both.ownerOf('0.1.0'), '0.1.0');

  // Nothing picked, or a pick the graph cannot resolve, draws no ring at all —
  // and an id the tree does not hold lends nothing either, however shaped it is.
  assert.equal(picksOf().labels, undefined, 'no picks, no labels');
  assert.equal(picksOf('9.9').labels, undefined, 'an id the tree does not hold picks nothing');
  assert.equal(picksOf('0.7').labels, undefined, 'not even a plausible sibling of a real one');
  assert.equal(picksOf('0.x').labels, undefined, 'nor one that is not a path of indices');
  assert.equal(picksOf('0.0').labels['0.1.0'], undefined, 'a pick of another frame lends nothing');
  // A graph rooted at one path still rings the copy of a pick made while the
  // reader was looking somewhere else — the set is one set across the four views.
  const rooted = explore.pickedFlamePicks(tree, tree.children[0], {
    enabled: true, selectedNodeIds: ['0.1.0'], onToggleSelection: () => {},
  });
  assert.deepEqual(rooted.labels, { '0.0.0': '1' },
    'a graph of one path rings the copy of the pick it does draw');
  assert.equal(rooted.ownerOf('0.0.0'), '0.1.0');
});

test('the published sheet carries the views\' styles, compiled', { skip: needsBuild }, () => {
  const css = readFileSync(new URL('dist/explore.css', pkgRoot), 'utf8');
  for (const selector of [
    '.explore-page', '.explore-tree-row', '.timeline-box', '.commit-slot', '.chart-notes',
    '.flame-legend-swatch', '.react-component-table', '.row-bar-fill', '.card-insight-label', '.brand',
    '.explore-picked-tick', '.explore-pickable-row', '.explore-tree-row.is-picked', '.explore-culprit-name',
  ]) {
    assert.ok(css.includes(selector), `${selector} is in the sheet`);
  }
  // The theme is the library's `.dark` class, not a media query: a plugin panel
  // inherits its host's appearance rather than the operating system's.
  assert.ok(css.includes('.dark'), 'the dark theme is the same `.dark` class the app uses');
  assert.ok(!css.includes('prefers-color-scheme'), 'nothing here overrides a host that chose the theme');
  assert.ok(css.includes('overflow-visible'), 'the utility the flame graph is given survived');
  assert.match(css, /--background:/, 'the design tokens come with it');
  assert.ok(!css.includes('@tailwind') && !css.includes('@source'), 'it is compiled, not a Tailwind entry');
  assert.ok(!css.includes('@import'), 'nothing left for a consumer\'s bundler to resolve');

  // Fonts are the host's. Tailwind would otherwise write its own stacks into
  // `:root`, and a consumer that loads this sheet second would lose its mono
  // and sans fonts — so the theme block names neither token, and the rules
  // read the host's token with a system stack behind it instead.
  const theme = css.slice(
    css.indexOf('@layer theme'),
    css.indexOf('}', css.indexOf(':root', css.indexOf('@layer theme'))),
  );
  assert.ok(theme.length > 100, 'the theme block was found to check');
  assert.ok(!/--font-mono:/.test(theme) && !/--font-sans:/.test(theme),
    'the sheet leaves the host\'s font tokens alone');
  const mono = css.match(/\.font-mono\s*\{[^}]*\}/);
  assert.ok(mono, 'the .font-mono utility is still generated');
  assert.match(mono[0], /var\(--font-mono,\s*var\(--font-mono,\s*ui-monospace/,
    'and it follows the host\'s --font-mono, with a fallback');
});

test('the built package asks nothing of Node or Next', { skip: needsBuild }, () => {
  const files = filesUnder(new URL('dist', pkgRoot).pathname);
  assert.ok(files.length > 20, 'there is a build to check');
  // A Node built-in or a `next/*` import would survive into a browser bundle as
  // a broken module, and one inside a `.d.ts` breaks whoever typechecks against
  // the package — which is why `TaskInsight` is copied rather than imported from
  // the app's module that reaches `lib/analysis.ts`.
  const unreachable = new RegExp(String.raw`(?:from|require\(|import\()\s*['"](?:node:|next\/|@/)`);
  for (const file of files) {
    assert.ok(!unreachable.test(readFileSync(file, 'utf8')), `${file} names a module a bundler cannot resolve`);
  }

  // A relative import has to carry its extension: a consumer on plain Node ESM
  // resolves `./format` literally and finds nothing. And it has to resolve at
  // all, or the barrel is broken the moment the package is installed.
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from ['"](\.[^'"]*)['"]/g)) {
      assert.match(specifier, /\.js$/, `${file} imports ${specifier} without an extension`);
      assert.ok(existsSync(new URL(specifier, `file://${file}`)), `${file} imports ${specifier}, which is not in dist`);
    }
  }

  // Declarations are read by a typechecker rather than a bundler, so they keep
  // naming `.ts` sources — and each of those has to exist as a `.d.ts` beside
  // the code, or the barrel is broken for whoever consumes it.
  for (const file of files.filter((name) => name.endsWith('.d.ts'))) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from ['"](\.[^'"]*)['"]/g)) {
      const resolved = new URL(specifier.replace(/\.tsx?$/, '.d.ts'), `file://${file}`);
      assert.ok(existsSync(resolved), `${file} declares ${specifier}, which is not in dist`);
    }
  }
});

test('a host that passes a selection gets picking in the React views too', { skip: needsBuild }, () => {
  // The same seam as the task side, over a recording instead of a task. What is
  // different here is the id: a fiber id is unique inside its root and nowhere
  // else, so the pick names the commit as well, which is what lets a selection
  // survive the commit picker a reader walks a cascade with.
  const handoff = reactHandoff();
  const longest = [...handoff.explore.commits].sort((a, b) => b.durationMs - a.durationMs)[0];
  assert.ok(longest && longest.tree.length > 0, 'the fixture has a commit with a tree');

  const fibers = [];
  const walk = (nodes) => { for (const node of nodes) { fibers.push(node); walk(node.children); } };
  walk(longest.tree);
  const heaviest = [...fibers].sort((a, b) => b.selfMs - a.selfMs)[0];
  const key = explore.reactNodeKey(longest, heaviest.id);

  assert.deepEqual(explore.reactNodeKeyParts(key),
    { rootId: longest.rootId, commitIndex: longest.commitIndex, fiberId: heaviest.id },
    'a pick says which commit it was made in, so a host can resolve it later');
  assert.equal(explore.reactNodeKeyParts('not.a.key'), undefined);
  assert.equal(explore.reactNodeKeyParts('1.2'), undefined, 'a commit key is not a component pick');

  const selection = { enabled: true, selectedNodeIds: [key], onToggleSelection: () => {} };

  // The render tree is the tab the explorer opens on, so this is the whole way
  // through: a hand-off and a set of ids in, a ringed and numbered box out.
  const html = renderToString(createElement(explore.ReactExplorer, { handoff, selection }));
  assert.match(html, /ring-2 ring-ring ring-inset/, 'the picked component is ringed in the icicle');
  assert.match(html, /text-primary-foreground">1</, 'and numbered as the pick it is');
  assert.match(html, /Click a component to add it to your selection/, 'and the hint says a click no longer zooms');

  // The table is the other half, and renders on its own because the tab beside
  // it is not mounted until a reader opens it.
  const table = renderToString(createElement(explore.ReactComponentTable, { commit: longest, selection }));
  assert.match(table, /class="[^"]*is-picked/, 'the picked row carries the pick class');
  assert.match(table, /class="explore-picked-tick/, 'and the pill that says which pick it is');
  assert.match(table, /aria-pressed="true"/, 'a picked row reports that it is pressed');

  // The regression this prop must not become: a host that asks for nothing sees
  // the recording it always saw, and its component names stay plain text rather
  // than becoming buttons that do nothing.
  const plain = renderToString(createElement(explore.ReactExplorer, { handoff }));
  assert.doesNotMatch(plain, /is-picked|explore-picked-tick/, 'no selection, no pick drawing');
  const plainTable = renderToString(createElement(explore.ReactComponentTable, { commit: longest }));
  assert.doesNotMatch(plainTable, /is-picked|explore-picked-tick|explore-pickable-row/);
  assert.match(plainTable, /<span class="react-component-name">/, 'a name that navigates nowhere is not a button');

  // A pick made in another commit is still held, and is simply not drawn here —
  // the view says so rather than losing it.
  const elsewhere = explore.reactNodeKey({ rootId: longest.rootId, commitIndex: longest.commitIndex + 50 }, heaviest.id);
  assert.equal(explore.reactPicksInCommit(longest, { enabled: true, selectedNodeIds: [key, elsewhere], onToggleSelection: () => {} }), 1,
    'only the picks of this commit count as this commit’s');
});

test('a React pick rings the fiber that was clicked and not its namesakes', { skip: needsBuild }, () => {
  // The opposite of the task side, deliberately. A task tree merges a function's
  // call sites, so one pick has to ring every box drawing it. React merges
  // nothing: two renders of one component are two fibers with their own causes,
  // their own changed props and their own time, and ringing both would claim a
  // sameness React did not record.
  const commit = { rootId: 1, commitIndex: 3 };
  const tree = {
    id: 'commit:0', name: 'Commit 3', value: 10, selfValue: 1,
    children: [
      { id: 'commit.0:7', name: 'Row', value: 5, selfValue: 5, children: [] },
      { id: 'commit.1:9', name: 'Row', value: 4, selfValue: 4, children: [] },
    ],
  };
  const picks = explore.pickedReactFlame(tree, commit, {
    enabled: true, selectedNodeIds: ['1.3.9'], onToggleSelection: () => {},
  });
  assert.deepEqual(picks.labels, { 'commit.1:9': '1' }, 'the other Row is a different render and stays unringed');
  assert.equal(picks.keyOf('commit.0:7'), '1.3.7', 'an unpicked box still knows which component a click would pick');
  assert.equal(picks.keyOf('commit:0'), undefined, 'the commit root is the reconciler, not a component');
  assert.equal(picks.drawnPicks, 1);

  const none = explore.pickedReactFlame(tree, commit, undefined);
  assert.equal(none.labels, undefined, 'no selection, no labels');
  assert.equal(none.keyOf('commit.0:7'), '1.3.7', 'and the mapping still works for the first pick of all');
});

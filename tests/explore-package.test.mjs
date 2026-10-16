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

test('the published sheet carries the views\' styles, compiled', { skip: needsBuild }, () => {
  const css = readFileSync(new URL('dist/explore.css', pkgRoot), 'utf8');
  for (const selector of [
    '.explore-page', '.explore-tree-row', '.timeline-box', '.commit-slot', '.chart-notes',
    '.flame-legend-swatch', '.react-component-table', '.row-bar-fill', '.card-insight-label', '.brand',
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

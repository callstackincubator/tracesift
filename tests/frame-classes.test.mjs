import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyByRule, ruleClassTable } from '../src/lib/frame-classes.ts';

const frame = (functionName, url = '') => ({ functionName, url, scriptId: '1', lineNumber: 0, columnNumber: 0 });

test('the URL decides whenever it carries a real path', () => {
  assert.equal(classifyByRule(frame('getUsers', 'src/api/users.ts')), 'app');
  assert.equal(classifyByRule(frame('lodashMap', 'node_modules/lodash/map.js')), 'library');
  assert.equal(classifyByRule(frame('render', 'static/js/vendors~main.4f2c.min.js')), 'library');
  assert.equal(classifyByRule(frame('readFileSync', 'node:fs')), 'native');
  assert.equal(classifyByRule(frame('datePrototypeToLocaleString', 'native date.js')), 'native');
});

test('the hardcoded lists are a floor under the URL', () => {
  // `beginWork` inside a bundle has no URL evidence at all; the framework list
  // is what keeps it from falling through as an unknown.
  assert.equal(classifyByRule(frame('beginWork', 'http://localhost:8081/index.bundle')), 'framework');
  assert.equal(classifyByRule(frame('(idle)', '')), 'native');
  assert.equal(classifyByRule(frame('(anonymous)', '')), 'anonymous');
});

test("V8's call wrappers are a call boundary, not an engine built-in", () => {
  // They carry no URL, so the urlless rule would otherwise file them with the
  // built-ins and the timeline would drop them — taking the nesting around the
  // frames underneath with them.
  assert.equal(classifyByRule(frame('Function call', '')), 'anonymous');
  assert.equal(classifyByRule(frame('FunctionCall', '')), 'anonymous');
  // Everything else without a URL is still the engine.
  assert.equal(classifyByRule(frame('(program)', '')), 'native');
  assert.equal(classifyByRule(frame('toString', '')), 'native');
});

test('a real name inside a bundle is residue no rule can settle', () => {
  assert.equal(classifyByRule(frame('Search_Search', 'http://localhost:8081/index.bundle')), undefined);
  assert.equal(classifyByRule(frame('Ci', 'https://cdn.example.com/app.min.js')), undefined);
});

test('the residue is filed as library and the table says it was degraded', () => {
  // Never `app`: a frame wrongly presented as the developer's own feature
  // boundary is worse than one left unclaimed.
  const frames = [frame('Search_Search', 'index.bundle'), frame('getUsers', 'src/api/users.ts')];
  const table = ruleClassTable(frames);
  assert.equal(table.classOf(frames[0]), 'library');
  assert.equal(table.classOf(frames[1]), 'app');
  assert.equal(table.degraded, true);
  assert.equal(table.unresolvedCount, 1);
});

test('a vendor chunk anywhere in the profile promotes named frames in its siblings', () => {
  // The whole profile decides this, not the frame: the same minified `main`
  // frame reads as the product's own code only because a `vendors~main` chunk
  // was recorded alongside it, which is why the table is built from every
  // frame rather than answering one at a time.
  const own = frame('SearchResults', 'static/js/main.4f2c.min.js');
  const alone = ruleClassTable([own]);
  assert.equal(alone.classOf(own), 'library');
  assert.equal(alone.degraded, true);

  const split = ruleClassTable([own, frame('render', 'static/js/vendors~main.4f2c.js')]);
  assert.equal(split.classOf(own), 'app');
  assert.equal(split.degraded, false);
});

test('a profile the rules answer in full is not degraded', () => {
  const table = ruleClassTable([frame('getUsers', 'src/api/users.ts'), frame('(idle)', '')]);
  assert.equal(table.degraded, false);
  assert.equal(table.unresolvedCount, 0);
});

test('a URL whose shape was chosen to be slow is still classified at a glance', () => {
  // The vendor-chunk rule reads an uploaded profile's URL, and the pattern it
  // used carried an unbounded run before a required separator and an end anchor,
  // which is quadratic the moment the tail cannot satisfy that anchor. One
  // crafted URL of this shape held the whole classification for seconds.
  const evil = { functionName: 'render', url: `vendors~${'-'.repeat(200_000)}/`, scriptId: '1', lineNumber: 0, columnNumber: 0 };
  const before = process.hrtime.bigint();
  assert.equal(classifyByRule(evil), undefined, 'a name no rule can settle still falls through');
  assert.equal(ruleClassTable([evil]).classOf(evil), 'library');
  const ms = Number(process.hrtime.bigint() - before) / 1e6;
  assert.ok(ms < 500, `classifying one pathological URL took ${ms.toFixed(0)} ms`);
});

test('no model runs for a classification, whatever is configured', async () => {
  // The guarantee this module exists to keep: uploading a profile is a
  // measurement. `pi-agent` is the only way to a provider, and nothing on
  // this path may reach it.
  const source = await import('node:fs/promises').then((fs) => fs.readFile('src/lib/frame-classes.ts', 'utf8'));
  assert.ok(!source.includes('pi-agent'), 'frame classification must not import the agent runner');
});

test('a webpack scheme is unwrapped, not filed with the engine', () => {
  // A webpack dev server hands every frame a `webpack-internal:` URL. Reading
  // the scheme as "no file on disk" collapsed a whole recording to `native`:
  // no frame was ever the developer's own, so no card found a boundary and the
  // collapse that hides React had nothing left to recognise.
  assert.equal(classifyByRule(frame('blockMainThread', 'webpack-internal:///./src/app/index.web.ts')), 'app');
  assert.equal(
    classifyByRule(frame('logComponentRender', 'webpack-internal:///./node_modules/react-dom/cjs/react-dom-client.development.js')),
    'framework',
  );
  assert.equal(classifyByRule(frame('map', 'webpack-internal:///./node_modules/lodash/map.js')), 'library');
  // A build layer sits between the scheme and the path, and a source map writes
  // the same path under a namespace instead.
  assert.equal(classifyByRule(frame('Page', 'webpack-internal:///(app-pages-browser)/./src/app/page.tsx')), 'app');
  assert.equal(classifyByRule(frame('getUsers', 'webpack://_N_E/./src/api/users.ts')), 'app');
  // The other virtual schemes still name no file.
  assert.equal(classifyByRule(frame('handler', 'chrome-extension://abc/background.js')), 'native');
  assert.equal(classifyByRule(frame('run', 'blob:http://localhost:3000/abc')), 'native');
});

test("Metro writes a bundle's parameters into the path, so the extension is followed by a slash", () => {
  // The real shape off a React Native capture: no `?` anywhere, the build
  // options live in the path. A rule anchored at `?`, `#` or end of string
  // matched none of them, which left the one bundler this rule exists for
  // reaching the residue branch by accident rather than by rule.
  const metro = 'http://192.168.68.55:8081/index.ts.bundle//&platform=ios&dev=true&lazy=true';
  assert.equal(classifyByRule(frame('loadModuleImplementation', metro)), undefined);
  // With a vendor chunk seen elsewhere in the recording, a meaningful name in
  // a sibling bundle is the product's own code.
  assert.equal(classifyByRule(frame('PostThread', metro), true), 'app');
  // A mangled one in the same bundle is still residue.
  assert.equal(classifyByRule(frame('t.A', metro), true), undefined);
});

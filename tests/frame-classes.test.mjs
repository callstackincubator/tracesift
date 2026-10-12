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

test('no model runs for a classification, whatever is configured', async () => {
  // The guarantee this module exists to keep: uploading a profile is a
  // measurement. `pi-agent` is the only way to a provider, and nothing on
  // this path may reach it.
  const source = await import('node:fs/promises').then((fs) => fs.readFile('src/lib/frame-classes.ts', 'utf8'));
  assert.ok(!source.includes('pi-agent'), 'frame classification must not import the agent runner');
});

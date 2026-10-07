import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyByRule, classifyFrames, frameClassKey } from '../src/lib/frame-classes.ts';

const frame = (functionName, url = '') => ({ functionName, url, scriptId: '1', lineNumber: 0, columnNumber: 0 });

/** Each case runs against its own TRACE_SIFT_HOME so the cache cannot leak between tests. */
async function isolatedHome() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tracesift-classes-'));
  process.env.TRACE_SIFT_HOME = dir;
  return dir;
}

test('the URL decides whenever it carries a real path', () => {
  assert.equal(classifyByRule(frame('getUsers', 'src/api/users.ts')), 'app');
  assert.equal(classifyByRule(frame('lodashMap', 'node_modules/lodash/map.js')), 'library');
  assert.equal(classifyByRule(frame('render', 'static/js/vendors~main.4f2c.js')), 'library');
  assert.equal(classifyByRule(frame('readFileSync', 'node:fs')), 'native');
  assert.equal(classifyByRule(frame('datePrototypeToLocaleString', 'native date.js')), 'native');
});

test('the hardcoded lists are a floor under the URL', () => {
  // `beginWork` inside a bundle has no URL evidence at all; the framework list
  // is what keeps it from reaching the model as an unknown.
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

test('a real name inside a bundle is the residue the model call exists for', () => {
  assert.equal(classifyByRule(frame('Search_Search', 'http://localhost:8081/index.bundle')), undefined);
  assert.equal(classifyByRule(frame('Ci', 'https://cdn.example.com/app.min.js')), undefined);
});

test('the model resolves the residue and nothing else is shown to it', async () => {
  await isolatedHome();
  const frames = [
    frame('Search_Search', 'index.bundle'),
    frame('beginWork', 'index.bundle'),
    frame('getUsers', 'src/api/users.ts'),
  ];
  let prompt = '';
  const table = await classifyFrames(frames, '/tmp', async (options) => {
    prompt = options.prompt;
    return { finalText: '{"frames":[{"i":0,"class":"app"}]}', turns: 1, toolCalls: [], lastStopReason: 'stop', usage: {} };
  });
  assert.ok(prompt.includes('Search_Search'));
  assert.ok(!prompt.includes('beginWork'), 'a frame the rules resolved must not be paid for again');
  assert.ok(!prompt.includes('getUsers'), 'a frame with a real path must not be paid for again');
  assert.equal(table.classOf(frames[0]), 'app');
  assert.equal(table.classOf(frames[1]), 'framework');
  assert.equal(table.degraded, false);
});

test('the table is cached by name and url, so a second profile of the same app runs no model', async () => {
  const home = await isolatedHome();
  const frames = [frame('Search_Search', 'index.bundle')];
  await classifyFrames(frames, '/tmp', async () => ({
    finalText: '{"frames":[{"i":0,"class":"app"}]}', turns: 1, toolCalls: [], lastStopReason: 'stop', usage: {},
  }));
  const persisted = JSON.parse(await readFile(path.join(home, 'frame-classes.json'), 'utf8'));
  assert.equal(persisted[frameClassKey(frames[0])], 'app');

  const second = await classifyFrames(frames, '/tmp', async () => {
    throw new Error('the model must not be called twice for the same frame');
  });
  assert.equal(second.classOf(frames[0]), 'app');
  assert.equal(second.degraded, false);
});

test('an unavailable model degrades the analysis instead of failing the upload', async () => {
  await isolatedHome();
  const frames = [frame('Search_Search', 'index.bundle')];
  const table = await classifyFrames(frames, '/tmp', async () => { throw new Error('no provider configured'); });
  assert.equal(table.degraded, true);
  // Never `app`: a frame wrongly presented as the developer's own feature
  // boundary is worse than one left unclaimed.
  assert.equal(table.classOf(frames[0]), 'library');
});

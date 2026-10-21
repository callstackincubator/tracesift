import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildReactCardPrompt } from '../src/lib/react-card-prompt.ts';
import { createReactAnalysisHandler } from '../src/lib/react-analysis-handler.ts';
import { parseReactExport } from '../src/lib/react-commit-tree.ts';
import { detectIntegrationProfileType, integrationEngineConflict, normalizedIntegrationAnalysis } from '../src/lib/integration-api.ts';

const home = await mkdtemp(path.join(tmpdir(), 'tracesift-integration-'));
process.env.TRACE_SIFT_HOME = home;
process.env.TRACE_SIFT_INTEGRATION_TOKEN = 'integration-test-token';
process.env.TRACE_SIFT_VERSION = '9.8.7';
process.env.TRACE_SIFT_INSTANCE = 'test-instance';
delete process.env.TRACESIFT_CPU_ENGINE;
delete process.env.TRACESIFT_REACT_ENGINE;

// Next resolves this alias in production. Register the equivalent only for
// this test process so the production route modules can be invoked directly.
const sourceRoot = path.resolve('src');
const sourceRootUrl = pathToFileURL(`${sourceRoot}/`).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return { url: pathToFileURL(path.join(sourceRoot, `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRootUrl) && !path.extname(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });

const { saveAnalysisSettings, findAnalysis, destroyRecord } = await import('../src/lib/analysis.ts');
const { GET: health } = await import('../src/app/api/integration/v1/health/route.ts');
const { POST: analyzeRoute } = await import('../src/app/api/integration/v1/analyze/route.ts');
const { POST: handoffRoute } = await import('../src/app/api/integration/v1/handoff/route.ts');
const { GET: taskRoute } = await import('../src/app/api/integration/v1/task/route.ts');
const { GET: reactExploreRoute } = await import('../src/app/api/integration/v1/react-explore/route.ts');

await saveAnalysisSettings({ autoSave: false });
test.after(() => rm(home, { recursive: true, force: true }));

function authorized(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer integration-test-token');
  return new Request(url, { ...init, headers });
}

test('integration health is authenticated and identifies the API and process instance', async () => {
  assert.equal(health(new Request('http://localhost/api/integration/v1/health')).status, 401);
  assert.equal(health(new Request('http://localhost/api/integration/v1/health', { headers: { Authorization: 'Bearer wrong-token-value' } })).status, 401);
  const response = health(authorized('http://localhost/api/integration/v1/health'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { apiVersion: 1, version: '9.8.7', instance: 'test-instance' });
});

test('profile detection accepts analyzer-supported CPU and React shapes and rejects ambiguity', () => {
  assert.equal(detectIntegrationProfileType({ nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 } }], samples: [] }), 'cpu');
  assert.equal(detectIntegrationProfileType({ version: 5, dataForRoots: [{ rootID: 1, displayName: 'main', commitData: [], operations: [], snapshots: [], initialTreeBaseDurations: [] }] }), 'react');
  assert.throws(() => detectIntegrationProfileType({}), /not a supported CPU profile or React/);
  assert.throws(() => detectIntegrationProfileType({
    nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 } }], samples: [],
    dataForRoots: [{ rootID: 1, displayName: 'main', commitData: [], operations: [], snapshots: [], initialTreeBaseDurations: [] }],
  }), /matches both/);
});

test('CPU normalization preserves task-card order and publishes compact summary metadata', () => {
  // The two drill-down fields are the bulk of a card and nothing on one draws
  // them, so a normalized card is the card without them; `/task` serves them.
  const first = { id: 'task-2', headline: 'first measured card', tree: { id: 'n0' }, timeline: { boxes: [] } };
  const second = { id: 'task-5', headline: 'second measured card' };
  assert.deepEqual(normalizedIntegrationAnalysis({
    analysisId: 'cpu-analysis', profileType: 'cpu', title: 'profile.cpuprofile', totalMs: 800,
    callCountIsExact: false, profileFunctions: { functions: [] },
    taskCards: { cards: [first, second], taskCount: 870, omittedTaskCount: 3, noLongTasks: false, profilerOverheadMs: 20 },
    cards: [{ id: 'retired-engine-card' }], hotspots: [],
  }), {
    apiVersion: 1, analysisId: 'cpu-analysis', profileType: 'cpu', title: 'profile.cpuprofile',
    summary: {
      totalMs: 800, callCountIsExact: false, profileFunctions: { functions: [] },
      taskCount: 870, omittedTaskCount: 3, noLongTasks: false, profilerOverheadMs: 20,
    },
    cards: [{ id: 'task-2', headline: 'first measured card' }, second],
  });
});

test('integration v1 rejects engines whose card shapes are outside its measured-card contract', () => {
  assert.equal(integrationEngineConflict('cpu', {}), undefined);
  assert.equal(integrationEngineConflict('react', {}), undefined);
  assert.match(integrationEngineConflict('cpu', { TRACESIFT_CPU_ENGINE: 'legacy' }), /Unset TRACESIFT_CPU_ENGINE/);
  assert.match(integrationEngineConflict('cpu', { TRACESIFT_CPU_ENGINE: 'cards' }), /current value: cards/);
  assert.match(integrationEngineConflict('react', { TRACESIFT_REACT_ENGINE: 'analyzer' }), /Unset TRACESIFT_REACT_ENGINE/);
  // Unknown values already fall back to the measured engines in the web routes.
  assert.equal(integrationEngineConflict('cpu', { TRACESIFT_CPU_ENGINE: 'unknown' }), undefined);
  assert.equal(integrationEngineConflict('react', { TRACESIFT_REACT_ENGINE: 'unknown' }), undefined);
});

test('React analysis normalizes ordered parity cards without changing its deterministic handoff', async t => {
  const profile = await readFile(path.resolve('sample-profiles/react/react-profile-2.json'));
  const form = new FormData();
  form.set('profile', new File([profile], 'react-profile-2.json', { type: 'application/json' }));
  const handler = createReactAnalysisHandler({ parse: parseReactExport });
  const response = await handler(new Request('http://localhost/api/analyze/react', { method: 'POST', body: form }));
  assert.equal(response.status, 200);
  const original = await response.json();
  const body = normalizedIntegrationAnalysis(original);
  t.after(() => destroyRecord(body.analysisId));
  assert.equal(body.apiVersion, 1);
  assert.equal(body.profileType, 'react');
  assert.equal(body.cards.length, 1);
  assert.equal(body.cards[0].headline, 'HeavyActivityHeatmap spent 124.8 ms rendering in a 169.7 ms commit');
  assert.equal(body.cards[0].culprits[0].component, 'HeavyActivityHeatmap');

  const record = await findAnalysis(body.analysisId);
  assert.equal(buildReactCardPrompt(body.cards[0], record.reactCards), buildReactCardPrompt(record.reactCards.cards[0], record.reactCards));
});

test('integration authentication rejects missing credentials without exposing data', async () => {
  const response = health(new Request('http://localhost/api/integration/v1/health'));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized.' });
});

test('authenticated CPU route analysis returns a card whose route handoff is deterministic', async t => {
  const profile = await readFile(path.resolve('sample-profiles/cpu/hermes-release-1.json'));
  const form = new FormData();
  form.set('profile', new File([profile], 'hermes-release-1.json', { type: 'application/json' }));
  form.set('profileType', 'auto');
  const analyzed = await analyzeRoute(authorized('http://localhost/api/integration/v1/analyze', {
    method: 'POST', body: form,
  }));
  assert.equal(analyzed.status, 200);
  const analysis = await analyzed.json();
  t.after(() => destroyRecord(analysis.analysisId));
  assert.equal(analysis.apiVersion, 1);
  assert.equal(analysis.profileType, 'cpu');
  assert.ok(analysis.cards.length > 0);

  const payload = JSON.stringify({ analysisId: analysis.analysisId, cardId: analysis.cards[0].id });
  const unauthenticated = await handoffRoute(new Request('http://localhost/api/integration/v1/handoff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
  }));
  assert.equal(unauthenticated.status, 401);

  const getHandoff = () => handoffRoute(authorized('http://localhost/api/integration/v1/handoff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
  }));
  const firstResponse = await getHandoff();
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.apiVersion, 1);
  assert.equal(typeof first.handoff, 'string');
  assert.ok(first.handoff.length > 0);
  const secondResponse = await getHandoff();
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).handoff, first.handoff);
});

test('integration task route guards its credentials, its parameters, and missing analyses', async () => {
  const unauthenticated = await taskRoute(new Request('http://localhost/api/integration/v1/task?analysisId=any&taskIndex=0'));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'Unauthorized.' });

  const badRequests = [
    'http://localhost/api/integration/v1/task?taskIndex=0',
    'http://localhost/api/integration/v1/task?analysisId=%20%20&taskIndex=0',
    'http://localhost/api/integration/v1/task?analysisId=some-analysis',
    'http://localhost/api/integration/v1/task?analysisId=some-analysis&taskIndex=not-a-number',
    'http://localhost/api/integration/v1/task?analysisId=some-analysis&taskIndex=1.5',
  ];
  for (const url of badRequests) {
    const response = await taskRoute(authorized(url));
    assert.equal(response.status, 400, url);
    assert.match((await response.json()).error, /taskIndex/);
  }

  const missing = await taskRoute(authorized('http://localhost/api/integration/v1/task?analysisId=no-such-analysis&taskIndex=0'));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /no longer available/);
});

test('integration task route serves one card whole, including the tree and timeline /analyze omits', async t => {
  const profile = await readFile(path.resolve('sample-profiles/cpu/hermes-release-1.json'));
  const form = new FormData();
  form.set('profile', new File([profile], 'hermes-release-1.json', { type: 'application/json' }));
  const analyzed = await analyzeRoute(authorized('http://localhost/api/integration/v1/analyze', {
    method: 'POST', body: form,
  }));
  assert.equal(analyzed.status, 200);
  const analysis = await analyzed.json();
  t.after(() => destroyRecord(analysis.analysisId));
  assert.ok(analysis.cards.length > 0);

  const { taskIndex } = analysis.cards[0];
  const response = await taskRoute(authorized(`http://localhost/api/integration/v1/task?analysisId=${analysis.analysisId}&taskIndex=${taskIndex}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, 1);
  assert.equal(body.analysisId, analysis.analysisId);
  assert.equal(body.title, 'hermes-release-1.json');
  assert.equal(typeof body.totalMs, 'number');
  assert.equal(body.card.taskIndex, taskIndex);
  assert.equal(body.card.id, analysis.cards[0].id);

  const record = await findAnalysis(analysis.analysisId);
  const stored = record.taskCards.cards.find(entry => entry.taskIndex === taskIndex);
  assert.ok(body.card.tree);
  assert.ok(body.card.timeline);
  assert.deepEqual(body.card.tree, JSON.parse(JSON.stringify(stored.tree)));
  assert.deepEqual(body.card.timeline, JSON.parse(JSON.stringify(stored.timeline)));

  const unknownTask = await taskRoute(authorized(`http://localhost/api/integration/v1/task?analysisId=${analysis.analysisId}&taskIndex=4242`));
  assert.equal(unknownTask.status, 404);
  assert.deepEqual(await unknownTask.json(), { error: 'That task is not part of this analysis.' });
});

test('integration react-explore route guards its credentials and its analyses', async () => {
  const unauthenticated = await reactExploreRoute(new Request('http://localhost/api/integration/v1/react-explore?analysisId=any'));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'Unauthorized.' });

  const badRequests = [
    'http://localhost/api/integration/v1/react-explore',
    'http://localhost/api/integration/v1/react-explore?analysisId=%20%20',
  ];
  for (const url of badRequests) {
    const response = await reactExploreRoute(authorized(url));
    assert.equal(response.status, 400, url);
    assert.match((await response.json()).error, /analysisId/);
  }

  const missing = await reactExploreRoute(authorized('http://localhost/api/integration/v1/react-explore?analysisId=no-such-analysis'));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /no longer available/);
});

test('integration react-explore route serves the commit timeline the analysis stored', async t => {
  const profile = await readFile(path.resolve('sample-profiles/react/react-profile-2.json'));
  const form = new FormData();
  form.set('profile', new File([profile], 'react-profile-2.json', { type: 'application/json' }));
  form.set('profileType', 'react');
  const analyzed = await analyzeRoute(authorized('http://localhost/api/integration/v1/analyze', {
    method: 'POST', body: form,
  }));
  assert.equal(analyzed.status, 200);
  const analysis = await analyzed.json();
  t.after(() => destroyRecord(analysis.analysisId));

  const response = await reactExploreRoute(authorized(`http://localhost/api/integration/v1/react-explore?analysisId=${analysis.analysisId}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, 1);
  assert.equal(body.analysisId, analysis.analysisId);
  assert.equal(body.title, 'react-profile-2.json');

  // The stored record is the only source of truth: the strip, the cards, and
  // this response are the same values, so no reader can disagree with another.
  const record = await findAnalysis(analysis.analysisId);
  const stored = JSON.parse(JSON.stringify({ explore: record.reactExplore, cards: record.reactCards.cards }));
  assert.ok(stored.explore.commits.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(body.explore)), stored.explore);
  assert.deepEqual(JSON.parse(JSON.stringify(body.cards)), stored.cards);
});

test('integration react-explore route refuses analyses that hold no commit timeline', async t => {
  const profile = await readFile(path.resolve('sample-profiles/cpu/hermes-release-1.json'));
  const form = new FormData();
  form.set('profile', new File([profile], 'hermes-release-1.json', { type: 'application/json' }));
  const analyzed = await analyzeRoute(authorized('http://localhost/api/integration/v1/analyze', {
    method: 'POST', body: form,
  }));
  assert.equal(analyzed.status, 200);
  const analysis = await analyzed.json();
  t.after(() => destroyRecord(analysis.analysisId));

  const response = await reactExploreRoute(authorized(`http://localhost/api/integration/v1/react-explore?analysisId=${analysis.analysisId}`));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no commit timeline/);
});

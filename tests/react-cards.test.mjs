import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseReactExport, splitSourceHint, unwrapComponentName, ReactCommitTreeError } from '../src/lib/react-commit-tree.ts';
import { buildReactCards, classifyReactComponent } from '../src/lib/react-cards.ts';
import { buildReactCardPrompt } from '../src/lib/react-card-prompt.ts';
import { inferReactCardInsight, reactInsightPrompt, REACT_INSIGHT_SYSTEM_PROMPT } from '../src/lib/react-insight.ts';
import { createReactAnalysisHandler } from '../src/lib/react-analysis-handler.ts';
import { destroyRecord, getRecord, saveAnalysisSettings } from '../src/lib/analysis.ts';
import { buildExport } from './react-export-fixture.mjs';

const cascadeComponents = Array.from({ length: 80 }, (_, index) => ({ id: 100 + index, name: `Row${index}` }));

test('a wide cascade of cheap components is a cascade, not a component issue', () => {
  const [recording] = parseReactExport(buildExport({
    components: [{ id: 2, name: 'FeedScreen(./feed.tsx)' }, ...cascadeComponents.map((c) => ({ ...c, parentId: 2 }))],
    commits: [{ duration: 64, updaters: ['FeedScreen'], fibers: cascadeComponents.map((c, i) => [c.id, 0.6 + i * 0.002]) }],
  }));
  const set = buildReactCards([recording], 16);
  const [card] = set.cards;
  assert.equal(card.shape, 'cascade');
  assert.equal(card.severity, 'high', 'four budgets long is high however the cost is spread');
  assert.match(card.headline, /^80 components re-rendered in a 64 ms commit, none over /);
  assert.match(card.shapeline, /median /);
  // No single component may be promoted into the headline of a cascade.
  assert.ok(card.culprits.every((culprit) => culprit.percentOfCommit < 5));
});

test('components that re-rendered with nothing changed are counted and costed', () => {
  const components = [{ id: 2, name: 'Dashboard(./dashboard.tsx)' }, ...cascadeComponents.map((c) => ({ ...c, parentId: 2 }))];
  const [recording] = parseReactExport(buildExport({
    components,
    commits: [{
      duration: 40,
      fibers: [[2, 1], ...cascadeComponents.map((c) => [c.id, 0.4])],
      causes: { 2: { context: false, didHooksChange: true, isFirstMount: false, props: [], state: null, hooks: [0] } },
    }],
  }));
  const set = buildReactCards([recording], 16);
  const [card] = set.cards;
  assert.equal(card.wasted.count, 80);
  assert.equal(card.wasted.selfMs, 32);
  assert.match(card.causeline, /80 re-rendered with nothing changed \(32 ms\)/);
  assert.equal(card.confidence, 'ok');
  assert.equal(set.components.find((row) => row.component === 'Row0').wastedRenders, 1);
});

test('a missing render-reason recording is not reported as nothing changed', () => {
  const [recording] = parseReactExport(buildExport({
    components: [{ id: 2, name: 'Dashboard' }],
    commits: [{ duration: 40, fibers: [[2, 30]], causes: null }],
  }));
  const set = buildReactCards([recording], 16);
  assert.equal(set.causesRecorded, false);
  assert.equal(set.cards[0].wasted, null, 'null, not zero: "none" and "not asked" are different answers');
  assert.equal(set.cards[0].confidence, 'low');
  assert.match(set.cards[0].causeline, /was not recorded in this profile/);
});

test('commits that repeat the same shape behind the same updater are a storm', () => {
  const [recording] = parseReactExport(buildExport({
    components: [{ id: 2, name: 'Ticker(./ticker.tsx)' }, { id: 3, name: 'Price', parentId: 2 }],
    commits: Array.from({ length: 6 }, (_, index) => ({
      duration: 4, timestamp: index * 16, updaters: ['Ticker'], fibers: [[2, 1], [3, 2]],
    })),
  }));
  const set = buildReactCards([recording], 16);
  assert.equal(set.noOverBudgetCommits, true, 'every commit fits a frame on its own');
  assert.equal(set.cards.length, 6, 'the busiest commits are still shown rather than an empty page');
  const [repeat] = set.repeats;
  assert.deepEqual(repeat.updaters, ['Ticker']);
  assert.equal(repeat.commitIndexes.length, 6);
  assert.equal(repeat.totalMs, 24);
});

test('effects are reported even when the render phase fits the budget', () => {
  const [recording] = parseReactExport(buildExport({
    components: [{ id: 2, name: 'Chart' }],
    commits: [{ duration: 20, fibers: [[2, 18]], effectDuration: 30, passiveEffectDuration: 12 }],
  }));
  const [card] = buildReactCards([recording], 16).cards;
  assert.equal(card.effectDurationMs, 30);
  assert.equal(card.passiveEffectDurationMs, 12);
  assert.match(card.effectline, /30 ms layout effects and 12 ms passive effects/);
});

test('self time is the only figure a finding is attributed to', () => {
  // A parent whose inclusive time is the whole commit but whose own time is nil
  // must never outrank the child that actually burned it.
  const [recording] = parseReactExport(buildExport({
    components: [{ id: 2, name: 'Provider.Provider' }, { id: 3, name: 'Grid(./grid.tsx)', parentId: 2 }],
    commits: [{ duration: 50, fibers: [[2, 0.1], [3, 44]] }],
  }));
  const [card] = buildReactCards([recording], 16).cards;
  assert.equal(card.culprits[0].component, 'Grid');
  assert.equal(card.culprits[0].sourceHint, './grid.tsx');
  assert.equal(card.shape, 'single');
  assert.ok(card.culprits.every((culprit) => culprit.componentClass !== 'framework'),
    'the provider is below the floor on its own time');
});

test('the checked-in samples reproduce the findings the model path reported', () => {
  const file = path.resolve('sample-profiles/react/react-profile-2.json');
  const [recording] = parseReactExport(JSON.parse(readFileSync(file, 'utf8')));
  const set = buildReactCards([recording], 16);
  assert.equal(set.commitCount, 4);
  assert.equal(set.commitsOverBudget, 1);
  const [card] = set.cards;
  assert.equal(card.id, 'react-commit-1-1');
  assert.equal(card.severity, 'high');
  const [culprit] = card.culprits;
  assert.equal(culprit.componentId, '1:728');
  assert.equal(culprit.component, 'HeavyActivityHeatmap');
  assert.equal(culprit.selfMs, 124.8);
  assert.equal(culprit.percentOfCommit, 73.5);
  // The string the current analyzer derives, word for word.
  assert.equal(culprit.evidence,
    'HeavyActivityHeatmap used 124.8 ms self time, 73.5% of a 169.7 ms over-budget React render.');
  assert.equal(card.pathline, 'DetailsScreen › … › View › ScrollView › HeavyActivityHeatmap');
});

test('two comparable components are both named', () => {
  const file = path.resolve('sample-profiles/react/react-profile-1.json');
  const [recording] = parseReactExport(JSON.parse(readFileSync(file, 'utf8')));
  const [card] = buildReactCards([recording], 16).cards;
  assert.equal(card.shape, 'few');
  assert.equal(card.headline, 'MerchantLeaderboard and SpendingSummary spent 243 ms of a 275.7 ms commit');
  assert.match(card.causeline, /^mostly a first mount: 153 of 280 components mounting/);
  assert.equal(card.updaterline, 'update scheduled by BaseNavigationContainer');
});

test('names, classes and source hints', () => {
  assert.equal(unwrapComponentName('Forget(Memo(HeavyActivityHeatmap))'), 'HeavyActivityHeatmap');
  assert.equal(unwrapComponentName('ExploreListScreen(./explore-list.tsx)'), 'ExploreListScreen');
  assert.deepEqual(splitSourceHint('Route(explore-details)'),
    { displayName: 'Route(explore-details)', sourceHint: null }, 'a route key is not a file');
  assert.deepEqual(splitSourceHint('Screen(../a/b.jsx)'), { displayName: 'Screen', sourceHint: '../a/b.jsx' });
  assert.equal(classifyReactComponent({ displayName: 'View', elementType: 7 }), 'host');
  assert.equal(classifyReactComponent({ displayName: 'Theme.Provider', elementType: 5 }), 'framework');
  assert.equal(classifyReactComponent({ displayName: 'VirtualizedList', elementType: 5 }), 'library');
  assert.equal(classifyReactComponent({ displayName: 'MerchantLeaderboard', elementType: 5 }), 'app');
  assert.equal(classifyReactComponent({ displayName: '#728', elementType: 5 }), 'unnamed');
});

test('a malformed export fails rather than inventing fibers', () => {
  assert.throws(() => parseReactExport({}), ReactCommitTreeError);
  assert.throws(() => parseReactExport({ dataForRoots: [] }), ReactCommitTreeError);
  const unknownOp = buildExport({ components: [{ id: 2, name: 'A' }], commits: [{ duration: 1, fibers: [[2, 1]] }] });
  unknownOp.dataForRoots[0].operations[0].push(99);
  assert.throws(() => parseReactExport(unknownOp), /needs a newer reader/);
});

// ── The HTTP path ───────────────────────────────────────────────────────────
// The measured engine needs no model, no child process and no working
// directory, so these run against the real handler with nothing stubbed.

const home = await mkdtemp(path.join(tmpdir(), 'tracesift-react-cards-home-'));
process.env.TRACE_SIFT_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));

function request(profile, options = {}, signal) {
  const form = new FormData();
  form.set('profile', new File([profile], 'react-profile.json', { type: 'application/json' }));
  for (const [key, value] of Object.entries(options)) form.set(key, String(value));
  return new Request('http://localhost/api/analyze/react', { method: 'POST', body: form, signal });
}

const handler = createReactAnalysisHandler({ parse: parseReactExport });

test('the measured engine answers over HTTP with no model and no temporary files', async t => {
  await saveAnalysisSettings({ aiAssisted: false, autoSave: false });
  const profile = await readFile(path.resolve('sample-profiles/react/react-profile-2.json'));
  const response = await handler(request(profile));
  assert.equal(response.status, 200, 'React profiles analyze with AI assist off');
  const body = await response.json();
  t.after(() => destroyRecord(body.analysisId));
  assert.equal(body.profileType, 'react');
  assert.equal(body.usage.totalTokens, 0);
  assert.equal(body.frameBudgetMs, 16);
  assert.equal(body.reactCards.cards.length, 1);
  assert.equal(body.reactCards.cards[0].culprits[0].component, 'HeavyActivityHeatmap');
  // The header line's figures, in the shape the results page already read.
  assert.deepEqual(body.summary, {
    rootCount: 1, commitCount: 4, totalCommitRenderDurationMs: 173,
    peakCommitDurationMs: 169.7, commitsOverBudget: 1, omittedEvidenceCommitCount: 0,
  });
  const record = getRecord(body.analysisId);
  assert.equal(record.reactCards.cards[0].id, 'react-commit-1-1');
  assert.equal(record.reactIssues.length, 0);
  assert.equal(record.dir, '', 'the upload is never written to disk');
  // The drill-down's data is built in the same pass and kept on the record:
  // the upload is gone, so there is nothing to re-read when Explore opens.
  assert.equal(record.reactExplore.commits.length, 4);
  assert.equal(record.reactExplore.commits.filter((commit) => commit.cardId).length, 1);
  assert.equal(record.reactExplore.budgetMs, 16);
});

test('a budget change moves the cut without re-reading the profile differently', async t => {
  const profile = await readFile(path.resolve('sample-profiles/react/react-profile-2.json'));
  const strict = await (await handler(request(profile, { frameBudgetMs: 1 }))).json();
  t.after(() => destroyRecord(strict.analysisId));
  // Three of the four clear 1 ms; the fourth commit rendered in 0.0 ms.
  assert.equal(strict.reactCards.commitsOverBudget, 3);
  assert.equal(strict.reactCards.cards.length, 3);
  const loose = await (await handler(request(profile, { frameBudgetMs: 500 }))).json();
  t.after(() => destroyRecord(loose.analysisId));
  assert.equal(loose.reactCards.noOverBudgetCommits, true);
  assert.equal(loose.reactCards.cards.length, 4, 'the busiest commits are still shown');
  assert.equal(loose.reactCards.cards[0].durationMs, 169.7);
});

test('malformed uploads fail with the status the reason deserves', async () => {
  assert.equal((await handler(request('not JSON'))).status, 400);
  assert.equal((await handler(request('{"version":5}'))).status, 400);
  assert.equal((await handler(request(''))).status, 400);
  assert.equal((await handler(new Request('http://localhost', { method: 'POST', body: 'not multipart' }))).status, 400);
  const noCommits = JSON.stringify({ version: 5, dataForRoots: [{ rootID: 1, displayName: 'main', commitData: [], operations: [], snapshots: [], initialTreeBaseDurations: [] }] });
  assert.equal((await handler(request(noCommits))).status, 422);
  assert.equal((await handler(request('{"dataForRoots":[]}'))).status, 400);
  for (const budget of ['0', '-1', 'NaN', '']) {
    assert.equal((await handler(request('{}', { frameBudgetMs: budget }))).status, 400);
  }
});

test('a cancelled request is answered as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await handler(request(await readFile(path.resolve('sample-profiles/react/react-profile-1.json')), {}, controller.signal));
  assert.equal(response.status, 499);
});

// ── The hand-off and the inference prompt ───────────────────────────────────

const sampleSet = buildReactCards(parseReactExport(JSON.parse(
  await readFile(path.resolve('sample-profiles/react/react-profile-1.json'), 'utf8'))), 16);

test('the hand-off names the components, the trigger and what it cannot know', () => {
  const prompt = buildReactCardPrompt(sampleSet.cards[0], sampleSet);
  assert.match(prompt, /investigate the root cause of this 275\.7 ms React commit/);
  assert.match(prompt, /`MerchantLeaderboard`.+142 ms of its own render time, 51\.5% of the commit/);
  assert.match(prompt, /scheduled by `BaseNavigationContainer`/);
  assert.match(prompt, /153 mounted for the first time/);
  // The limits that decide what the receiving agent does next.
  assert.match(prompt, /no call stack below a component/);
  assert.match(prompt, /Render time is not paint time/);
  assert.match(prompt, /Inclusive time is not reported here on purpose/);
  assert.doesNotMatch(prompt, /\bconsider\b/i, 'the hand-off states evidence, it does not advise');
});

test('a hand-off for a profile with no render reasons says so instead of guessing', async () => {
  const set = buildReactCards(parseReactExport(JSON.parse(
    await readFile(path.resolve('sample-profiles/react/react-profile-2.json'), 'utf8'))), 16);
  const prompt = buildReactCardPrompt(set.cards[0], set);
  assert.match(prompt, /## Why React rendered them\nNot recorded\./);
  assert.match(prompt, /Record why each component rendered/);
  assert.doesNotMatch(prompt, /with nothing changed/);
});

test('an AI reading is labelled as one in the hand-off, above the evidence', () => {
  const card = { ...sampleSet.cards[0], insight: { title: 'Two cards rebuilt on mount', findings: ['A finding.'] } };
  const prompt = buildReactCardPrompt(card, sampleSet);
  assert.ok(prompt.indexOf('## What this looks like') < prompt.indexOf('## The commit'));
  assert.match(prompt, /not a measurement, and no source file was opened/);
});

test('the inference prompt carries measurements and refuses to carry a call stack', () => {
  const prompt = reactInsightPrompt(sampleSet.cards[0], sampleSet);
  assert.match(prompt, /React spent 275\.7 ms rendering/);
  assert.match(prompt, /`MerchantLeaderboard` \(\.\/.+\)|`MerchantLeaderboard` \[app\]/);
  assert.match(prompt, /true partition/);
  assert.match(REACT_INSIGHT_SYSTEM_PROMPT, /must not pretend to have/);
  assert.match(REACT_INSIGHT_SYSTEM_PROMPT, /A first mount is not a wasted render/);
});

test('an inference is never required: an unreachable model leaves the card measured', async () => {
  const result = await inferReactCardInsight(sampleSet.cards[0], sampleSet, tmpdir(), async () => {
    throw new Error('Provider unavailable');
  });
  assert.equal(result.insight, undefined);
  assert.equal(result.usage.totalTokens, 0);
  const unusable = await inferReactCardInsight(sampleSet.cards[0], sampleSet, tmpdir(), async () => ({
    finalText: 'I could not read this.', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 },
  }));
  assert.equal(unusable.insight, undefined);
  assert.equal(unusable.usage.totalTokens, 2, 'the call still cost what it cost');
  const good = await inferReactCardInsight(sampleSet.cards[0], sampleSet, tmpdir(), async () => ({
    finalText: '{"title":"Two cards rebuilt on mount","findings":["- A finding."]}',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 },
  }));
  assert.deepEqual(good.insight, { title: 'Two cards rebuilt on mount', findings: ['A finding.'] });
});

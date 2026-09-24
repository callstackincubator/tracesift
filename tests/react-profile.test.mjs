import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractReactProfile, parseReactProfileOptions, resolveReactProfilerCli, validateReactProfileResult } from '../src/lib/react-profile.ts';
import { analyzeReactProfile, normalizeStoredReactIssues, reactAnalystPrompt, reactIssueRemainingMs, reactIssueSeverity, validateReactIssueReport, discardSubBudgetReactIssues } from '../src/lib/react-analyzer.ts';
import { parseFrameBudget, validateReactEvidence } from '../src/lib/react-evidence.ts';
import { createReactAnalysisHandler } from '../src/lib/react-analysis-handler.ts';
import { destroyRecord, getRecord } from '../src/lib/analysis.ts';
import { buildReactFixPrompt } from '../src/lib/prompts.ts';

const exec = promisify(execFile);
const fixture = path.resolve('test-fixtures/react/react-native-v5.synthetic.json');
const defaults = { limit: 10, rootID: null, componentName: null, minAvgDurationMs: 0 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 };
const traceSiftHome = await mkdtemp(path.join(tmpdir(), 'tracesift-react-home-'));
process.env.TRACE_SIFT_HOME = traceSiftHome;
test.after(() => rm(traceSiftHome, { recursive: true, force: true }));
const load = () => extractReactProfile(fixture, defaults);
const loadEvidence = (file = fixture, options = defaults) => extractReactProfile(file, options, undefined, { analysisEvidence: true });
const emptyReport = { issues: [], noIssue: true };
const issueReport = (result) => {
  const commit = result.evidence.commits.find(c => c.durationMs > 16 && c.components.length);
  return { noIssue: false, issues: [{
    componentId: commit.components[0].id,
    commits: [{ rootID: commit.rootID, commitIndex: commit.commitIndex }],
  }] };
};
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'react-profile-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function editedFixture(t, edit) {
  const profile = JSON.parse(await readFile(fixture, 'utf8'));
  edit(profile);
  const file = path.join(await temporary(t), 'profile.json');
  await writeFile(file, JSON.stringify(profile));
  return file;
}
function request(profile, options = {}, signal) {
  const form = new FormData();
  form.set('profile', new File([profile], 'react-profile.json', { type: 'application/json' }));
  for (const [key, value] of Object.entries(options)) form.set(key, String(value));
  return new Request('http://localhost/api/analyze/react', { method: 'POST', body: form, signal });
}

test('actual patched CLI ranks separate instances by inclusive averages and replays mount/unmount operations', async t => {
  const dir = await temporary(t), state = path.join(dir, 'state');
  const { stdout, stderr } = await exec(process.execPath, [resolveReactProfilerCli(), 'profile', 'slow', '--file', fixture, '--json', '--state-dir', state]);
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').length, 1);
  await assert.rejects(access(state), { code: 'ENOENT' });
  const result = validateReactProfileResult(JSON.parse(stdout), defaults);
  assert.deepEqual(result.components.map(c => c.id), ['10:2', '1:5', '1:2', '1:3', '1:6']);
  assert.deepEqual(result.summary, { rootCount: 2, commitCount: 4, totalCommitRenderDurationMs: 110, candidateCount: 6, matchingCount: 5, omittedCount: 0 });
  const row = result.components[2];
  assert.equal(row.renderCount, 3); // Includes zero; excludes commits in the other root.
  assert.equal(row.avgActualDurationMs, 10);
  assert.equal(row.totalActualDurationMs, 30);
  assert.equal(row.avgSelfDurationMs, 2);
  assert.equal(row.maxSelfDurationMs, 4);
  assert.equal(result.components[1].displayName, 'Hëavy🧩');
  assert.equal(result.components[1].peakCommit.commitIndex, 1);
  assert.equal(result.components[3].totalSelfDurationMs, null);
  assert.equal(result.components[3].selfRenderCount, 1);
  assert.equal(result.components[4].metadataMissing, true);
  assert.equal(result.components[4].displayName, 'Component#6');
});

test('scoping precedes limiting and matching is case insensitive', async () => {
  const result = await extractReactProfile(fixture, { limit: 1, rootID: 1, componentName: 'rOW', minAvgDurationMs: 10 });
  assert.deepEqual(result.components.map(c => c.id), ['1:2']);
  assert.equal(result.summary.matchingCount, 2);
  assert.equal(result.summary.omittedCount, 1);
  assert.equal((await extractReactProfile(fixture, { ...defaults, minAvgDurationMs: 41 })).components.length, 0);
  const { stdout } = await exec(process.execPath, [resolveReactProfilerCli(), 'profile', 'slow', '--file', fixture, '--limit', '1']);
  assert.match(stdout, /10:2 "Row": avg 40.00 ms/);
});

test('new roots and empty operation lists are supported', async t => {
  const file = await editedFixture(t, data => {
    data.dataForRoots = [data.dataForRoots[1]];
    const root = data.dataForRoots[0];
    root.snapshots = [];
    root.operations = [[1, 10, 4, 3, 82, 111, 119, 1, 10, 11, 0, 1, 1, 1, 1, 2, 5, 10, 0, 1, 0]];
  });
  assert.equal((await extractReactProfile(file, defaults)).components[0].displayName, 'Row');
  const empty = await editedFixture(t, data => data.dataForRoots.forEach(root => root.operations = root.commitData.map(() => [])));
  assert.equal((await extractReactProfile(empty, defaults)).components.find(c => c.id === '1:5').metadataMissing, true);
});

test('mounted memo and compiler wrappers use the same names as DevTools snapshots', async t => {
  const file = await editedFixture(t, data => {
    const name = [...'Forget(Memo(Row))'].map(character => character.codePointAt(0));
    data.dataForRoots[0].operations[1] = [1, 1, name.length + 1, name.length, ...name, 1, 5, 8, 1, 0, 1, 0];
  });
  const result = await extractReactProfile(file, defaults);
  assert.equal(result.components.find(component => component.id === '1:5').displayName, 'Row');
});

test('rejects unsupported encodings, invalid numbers, duplicate IDs and malformed trees', async t => {
  for (const edit of [
    data => data.version = 4,
    data => data.dataForRoots[0].operations[0] = [1, 1, 0, 99],
    data => data.dataForRoots[0].operations[0] = [1, 1, 4, 3, 65],
    data => data.dataForRoots[0].operations[0] = [1, 1, 0, 1, 9, 5, 1, 0, 100, 0],
    data => data.dataForRoots[0].operations.pop(),
    data => data.dataForRoots[0].commitData[0].fiberActualDurations.push([2, 5]),
    data => data.dataForRoots[0].commitData[0].duration = -1,
    data => data.dataForRoots[0].commitData[0].fiberActualDurations[0][1] = '30',
    data => data.dataForRoots[0].snapshots[1][1].children = [1],
    data => data.dataForRoots[0].operations[0] = [1, 1, 0, 2, 100],
    data => data.dataForRoots[0].operations[0] = [1, 1, 0, 6],
  ]) {
    const file = await editedFixture(t, edit);
    await assert.rejects(extractReactProfile(file, defaults), { status: 400 });
  }
});

test('offline CLI rejects bad flags without starting the daemon, and diff still works', async t => {
  const dir = await temporary(t), state = path.join(dir, 'state');
  for (const flags of [ ['--file'], ['--file', fixture, '--limit', '0'], ['--file', fixture, '--limit', '101'],
    ['--file', fixture, '--limit', '2junk'], ['--file', fixture, '--json=false'], ['--file', fixture, '--root-id', '-1'],
    ['--file', fixture, '--min-avg-duration', 'NaN'], ['--json'], ['--file', fixture, '--wat'],
  ]) {
    await assert.rejects(exec(process.execPath, [resolveReactProfilerCli(), 'profile', 'slow', ...flags, '--state-dir', state]), error => {
      assert.equal(error.code, 2); assert.equal(error.stdout, ''); assert.ok(error.stderr); return true;
    });
  }
  await assert.rejects(access(state), { code: 'ENOENT' });
  const { stdout } = await exec(process.execPath, [resolveReactProfilerCli(), 'profile', 'diff', fixture, fixture, '--state-dir', state]);
  assert.match(stdout, /[Cc]ommit/);
  await assert.rejects(access(state), { code: 'ENOENT' });
});

test('wrapper distinguishes timeout, cancellation, bad output and executable failures', async t => {
  const dir = await temporary(t), cliPath = path.join(dir, 'fake.cjs'), pidFile = path.join(dir, 'pid');
  await writeFile(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  await assert.rejects(extractReactProfile(fixture, defaults, undefined, { cliPath, timeoutMs: 300 }), { status: 504 });
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const controller = new AbortController();
  const pending = extractReactProfile(fixture, defaults, controller.signal, { cliPath });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { status: 499 });
  await assert.rejects(extractReactProfile(fixture, defaults, controller.signal, { cliPath }), { status: 499 });
  for (const [code, status] of [
    ["console.log('not json')", 502], ["console.log('{}')", 502],
    ["console.log('x'.repeat(10000))", 502], ["process.exit(1)", 500],
    ["console.error('bad profile');process.exit(2)", 400],
  ]) {
    await writeFile(cliPath, code);
    await assert.rejects(extractReactProfile(fixture, defaults, undefined, { cliPath, maxBuffer: 2000 }), { status });
  }
});

test('wire validation rejects corrupt metrics, IDs, filtering and rank', async () => {
  const result = await load();
  for (const edit of [
    data => data.components.reverse(),
    data => data.components[0].id = 'invented',
    data => data.components[0].avgActualDurationMs = 1,
    data => data.summary.omittedCount = 999,
    data => data.components[0].peakCommit.rootID = 999,
    data => data.components[0].selfRenderCount = 0,
    data => data.filters.limit = 50,
  ]) {
    const bad = structuredClone(result); edit(bad);
    assert.throws(() => validateReactProfileResult(bad, defaults), { status: 502 });
  }
});

test('mocked analyzer selects issues but cannot change identities or measurements', async () => {
  const measured = await loadEvidence();
  assert.ok(Buffer.byteLength(reactAnalystPrompt(measured)) < 30000);
  const report = issueReport(measured);
  report.issues[0].component = 'Invented name';
  report.issues[0].commits[0].durationMs = 9999;
  const analyzed = await analyzeReactProfile(measured, tmpdir(), async options => {
    assert.deepEqual(options.builtinTools, []);
    assert.deepEqual(options.customTools, []);
    assert.equal(options.maxOutputTokens, 4096);
    assert.match(options.systemPrompt, /Do not invent/);
    const payload = JSON.parse(options.prompt);
    assert.equal(payload.commitDurations, undefined);
    assert.equal(payload.thresholds.commitDurationMs, 16);
    assert.equal(payload.slowestComponentsByAverageDuration, undefined);
    assert.equal(payload.componentsByRenderCount, undefined);
    assert.equal(payload.componentsByTotalSelfDuration, undefined);
    assert.ok(payload.commits.every(commit => commit.durationMs > 16));
    return { finalText: JSON.stringify(report), usage };
  });
  assert.equal(analyzed.issues.length, 1);
  assert.match(analyzed.issues[0].summary, /^Expensive render work in /);
  assert.match(analyzed.issues[0].evidence, /self time/);
  assert.deepEqual(analyzed.usage, usage);
  const fallback = await analyzeReactProfile(measured, tmpdir(), async () => ({ finalText: '```json\n' + JSON.stringify(emptyReport) + '\n```', usage }));
  assert.equal(fallback.issues.length, 0);
  assert.equal(fallback.noIssue, true);
  await assert.rejects(analyzeReactProfile(measured, tmpdir(), async () => ({ finalText: '{}', usage })), { status: 502 });
});

test('one-turn no-issue reports discard legacy reasoning', async () => {
  const measured = await loadEvidence();
  const analyzed = await analyzeReactProfile(measured, tmpdir(), async options => {
    assert.deepEqual(options.customTools, []);
    return { finalText: JSON.stringify(emptyReport), usage };
  });
  assert.deepEqual(analyzed, { ...emptyReport, usage });
  const legacy = { ...emptyReport, reasoning: 'A long explanation of why no issues were found.' };
  assert.deepEqual(validateReactIssueReport(legacy, measured.evidence, 16), emptyReport);
  assert.deepEqual(discardSubBudgetReactIssues(legacy, measured.evidence, 16), emptyReport);
});

test('HTTP success runs actual CLI, forwards filtered results, and cleans its upload', async t => {
  const root = await temporary(t);
  let seenDir;
  const handler = createReactAnalysisHandler({ extract: extractReactProfile, temporaryRoot: root, analyze: async (result, cwd) => {
    seenDir = cwd;
    await access(path.join(cwd, 'profile.json'));
    assert.equal(result.components.length, 1);
    assert.equal(result.components[0].id, '1:2');
    return { ...emptyReport, usage };
  } });
  const response = await handler(request(await readFile(fixture), { rootId: 1, componentName: 'row', limit: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.profileType, 'react');
  assert.equal(typeof body.analysisId, 'string');
  t.after(() => destroyRecord(body.analysisId));
  assert.equal(body.components, undefined);
  assert.deepEqual(body.issues, []);
  await assert.rejects(access(seenDir), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
});

test('HTTP issue reports persist an analysis id for prompt generation and still remove the upload', async t => {
  const root = await temporary(t);
  let seenDir;
  const handler = createReactAnalysisHandler({ extract: extractReactProfile, temporaryRoot: root, analyze: async (result, cwd) => {
    seenDir = cwd;
    return { ...validateReactIssueReport(issueReport(result), result.evidence, 16), usage };
  } });
  const response = await handler(request(await readFile(fixture)));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.analysisId, 'string');
  assert.ok(body.issues.length > 0);
  const record = getRecord(body.analysisId);
  assert.equal(record.reactIssues[0].id, body.issues[0].id);
  assert.equal(record.hotspots.length, 0);
  t.after(() => destroyRecord(body.analysisId));
  await assert.rejects(access(seenDir), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
});

test('HTTP errors skip the model where appropriate and always remove temporary files', async t => {
  const root = await temporary(t);
  let calls = 0;
  const handler = createReactAnalysisHandler({ extract: extractReactProfile, temporaryRoot: root, analyze: async () => {
    calls++; const error = new Error('Provider unavailable'); error.status = 503; throw error;
  } });
  for (const [req, status] of [
    [request('not JSON'), 400], [request('null'), 400],

    [request(await readFile(fixture), { limit: 13 }), 400],
    [request(''), 400], [request(new Uint8Array(25 * 1024 * 1024 + 1)), 413],
    [new Request('http://localhost', { method: 'POST', body: 'not multipart' }), 400],
  ]) {
    assert.equal((await handler(req)).status, status);
    assert.deepEqual(await readdir(root), []);
  }
  assert.equal(calls, 0);
  assert.equal((await handler(request(await readFile(fixture)))).status, 503);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
});

test('HTTP cancellation cleans up after extraction and does not call the model', async t => {
  const root = await temporary(t), controller = new AbortController();
  const handler = createReactAnalysisHandler({ temporaryRoot: root, extract: async () => { controller.abort(); return loadEvidence(); }, analyze: async () => { assert.fail('model must not run'); } });
  assert.equal((await handler(request(await readFile(fixture), {}, controller.signal))).status, 499);
  assert.deepEqual(await readdir(root), []);
});

test('HTTP numeric options reject partial numbers and missing flag values', () => {
  for (const [key, value] of [['limit', '1x'], ['limit', '0'], ['rootId', '-1'], ['componentName', ''], ['minAvgDurationMs', 'Infinity']]) {
    const form = new FormData(); form.set(key, value);
    assert.throws(() => parseReactProfileOptions(form), { status: 400 });
  }
});

function syntheticProfile(durations, names = ['NavigationContent', 'Context.Provider', 'ExpensiveList']) {
  const ids = names.map((_, i) => i + 2);
  const node = (id, displayName, children, type = 5) => [id, { id, displayName, children, type, key: null }];
  return { version: 5, dataForRoots: [{ rootID: 1, initialTreeBaseDurations: [],
    snapshots: [node(1, null, [2], 11), ...names.map((name, i) => node(ids[i], name, i < ids.length - 1 ? [ids[i + 1]] : []))],
    operations: durations.map(() => []),
    commitData: durations.map((ms, index) => ({ duration: ms, timestamp: index * 100,
      fiberActualDurations: ids.map(id => [id, ms]),
      fiberSelfDurations: ids.map((id, i) => [id, i === ids.length - 1 ? Math.max(0, ms - .2) : .1]),
      changeDescriptions: ids.map((id, i) => [id, index === 0 ? { isFirstMount: true } : i === 1 ? { context: true } : { props: ['data'] }]),
      updaters: [{ displayName: 'ExpensiveList' }],
    })),
  }] };
}
async function profileFile(t, profile) {
  const file = path.join(await temporary(t), 'profile.json');
  await writeFile(file, JSON.stringify(profile));
  return file;
}

test('budget guard skips the model for cheap navigation/provider cascades, mounts and frequent renders', async t => {
  for (const [durations, budget] of [[[2, 3, 2, 1], 16], [[16], 16], [[8.33], 8.33], [Array(100).fill(2), 16]]) {
    const result = await loadEvidence(await profileFile(t, syntheticProfile(durations)));
    const response = await analyzeReactProfile(result, tmpdir(), async () => assert.fail('cheap work must skip the model'), budget);
    assert.deepEqual(response.issues, []);
    assert.equal(response.noIssue, true);
    assert.equal(response.usage.totalTokens, 0);
    assert.equal(Object.hasOwn(response, 'reasoning'), false);
    const guarded = discardSubBudgetReactIssues({ issues: [{ summary: 'Provider updated!' }], noIssue: false, reasoning: 'bad' }, result.evidence, budget);
    assert.deepEqual(guarded.issues, []);
  }
});

test('unrounded fractional budgets permit selective analysis immediately above the boundary', async t => {
  const result = await loadEvidence(await profileFile(t, syntheticProfile([8.33001])));
  let calls = 0;
  const response = await analyzeReactProfile(result, tmpdir(), async options => {
    calls++;
    assert.equal(JSON.parse(options.prompt).commitsOverBudget, 1);
    return { finalText: JSON.stringify(emptyReport), usage };
  }, 8.33);
  assert.equal(calls, 1);
  assert.equal(response.noIssue, true); // Over budget does not compel findings.
});

test('analysis finds a self-expensive descendant outside the raw ranking limit and name filters', async t => {
  const file = await profileFile(t, syntheticProfile([30]));
  const result = await loadEvidence(file, { ...defaults, limit: 1, componentName: 'NavigationContent' });
  assert.deepEqual(result.components.map(c => c.displayName), ['NavigationContent']);
  const commit = result.evidence.commits[0];
  assert.equal(commit.components[0].displayName, 'ExpensiveList');
  const report = issueReport(result);
  const analyzed = await analyzeReactProfile(result, tmpdir(), async () => ({ finalText: JSON.stringify(report), usage }));
  assert.equal(analyzed.issues[0].components[0].component, 'ExpensiveList');
  assert.equal(analyzed.issues.length, 1);
  assert.ok(result.evidence.componentsByRenderCount.some(c => c.displayName === 'Context.Provider'));
});

test('excludes root-wide issues without blaming individual cheap components', async t => {
  const data = syntheticProfile([24]);
  data.dataForRoots[0].commitData[0].fiberSelfDurations = [[2, 8], [3, 8], [4, 8]];
  const result = await loadEvidence(await profileFile(t, data));
  const report = issueReport(result);
  delete report.issues[0].componentId;
  report.issues[0].summary = 'Combined render work exceeds budget';
  const validated = validateReactIssueReport(report, result.evidence, 16);
  assert.equal(validated.issues.length, 0);
  assert.equal(validated.noIssue, true);
  assert.equal(Object.hasOwn(validated, 'reasoning'), false);
  const analyzed = await analyzeReactProfile(result, tmpdir(), async () => ({ finalText: JSON.stringify(report), usage }));
  assert.equal(analyzed.noIssue, true);
  assert.deepEqual(analyzed.issues, []);
});

test('retains component findings when an unattributed root issue is discarded', async () => {
  const result = await loadEvidence();
  const report = issueReport(result);
  const rootIssue = structuredClone(report.issues[0]);
  delete rootIssue.componentId;
  report.issues.unshift(rootIssue);
  const validated = validateReactIssueReport(report, result.evidence, 16);
  assert.equal(validated.issues.length, 1);
  assert.equal(validated.noIssue, false);
  assert.equal(validated.issues[0].components[0].componentId, report.issues[1].componentId);
});

test('rejects a root fiber even if it occurs in supplied component evidence', async () => {
  const result = await loadEvidence();
  const report = issueReport(result);
  const commit = result.evidence.commits.find(c => c.rootID === report.issues[0].commits[0].rootID
    && c.commitIndex === report.issues[0].commits[0].commitIndex);
  commit.components[0].fiberID = commit.rootID;
  commit.components[0].id = `${commit.rootID}:${commit.rootID}`;
  report.issues[0].componentId = commit.components[0].id;
  assert.throws(() => validateReactIssueReport(report, result.evidence, 16), { status: 502 });
});

test('evidence limits preserve all-commit metrics and the three aggregate views', async t => {
  const data = syntheticProfile(Array.from({ length: 80 }, (_, i) => i + 1), Array.from({ length: 20 }, (_, i) => `Component ${i}`));
  const result = await loadEvidence(await profileFile(t, data));
  const e = result.evidence;
  assert.equal(e.summary.commitCount, 80);
  assert.equal(e.summary.totalCommitRenderDurationMs, 3240);
  assert.equal(e.summary.peakCommitDurationMs, 80);
  assert.equal(e.commits.length, 50);
  assert.equal(e.omittedCommitCount, 30);
  assert.equal(e.commits[0].durationMs, 80);
  assert.equal(e.commits[0].components.length, 10);
  assert.equal(e.commits[0].omittedComponentCount, 10);
  for (const key of ['slowestComponentsByAverageDuration', 'componentsByRenderCount', 'componentsByTotalSelfDuration']) assert.equal(e[key].length, 15);
  assert.equal(e.omittedAggregateComponentCount, 5);
});

test('evidence scopes roots and preserves missing self timings, render reasons, and mounted identities', async () => {
  const result = await loadEvidence();
  assert.ok(result.evidence.commits.some(c => c.components.some(row => row.displayName === 'Hëavy🧩')));
  const partial = result.evidence.componentsByRenderCount.find(c => c.id === '1:3');
  assert.equal(partial.totalSelfDurationMs, null);
  assert.ok(partial.causes.includes('unknown'));
  const scoped = await loadEvidence(fixture, { ...defaults, rootID: 10, minAvgDurationMs: 1000 });
  assert.equal(scoped.components.length, 0);
  assert.equal(scoped.evidence.summary.rootCount, 1);
  assert.equal(scoped.evidence.summary.commitCount, 1);
  assert.ok(scoped.evidence.commits.every(c => c.rootID === 10));
});

test('report validation rejects fabricated, duplicate, mismatched and sub-budget evidence', async () => {
  const result = await loadEvidence();
  for (const edit of [
    r => r.issues[0].componentId = 'invented',
    r => r.issues[0].commits[0].rootID = 999,
    r => r.issues[0].commits[0].commitIndex = 999,
    r => r.issues[0].commits.push(r.issues[0].commits[0]),
    r => r.issues[0].commits = [],
    r => r.issues[0].componentId = 42,
    r => r.noIssue = true,
    r => r.issues.push(r.issues[0]),
    r => r.issues[0].componentId = '1:2', // selected commit belongs to root 10
  ]) {
    const raw = issueReport(result); edit(raw);
    assert.throws(() => validateReactIssueReport(raw, result.evidence, 16), { status: 502 });
  }
  assert.throws(() => validateReactIssueReport(issueReport(result), result.evidence, 100), { status: 502 });
  assert.deepEqual(validateReactIssueReport(emptyReport, result.evidence, 16), emptyReport);
});

test('issue title, timing evidence, and severity are derived from measured data', async () => {
  const result = await loadEvidence();
  const raw = issueReport(result);
  raw.issues[0].summary = 'Invented first-paint delay';
  raw.issues[0].evidence = 'Invented mount evidence';
  raw.issues[0].severity = 'low';
  const validated = validateReactIssueReport(raw, result.evidence, 16);
  assert.match(validated.issues[0].summary, /^Expensive render work in /);
  assert.match(validated.issues[0].evidence, /^.+ used [\d.]+ ms self time, [\d.]+% of a [\d.]+ ms over-budget React render\.$/);
  assert.doesNotMatch(validated.issues[0].summary + validated.issues[0].evidence, /first-paint|mount/i);
  assert.equal(validated.issues[0].severity, reactIssueSeverity(validated.issues[0].components[0].selfTimeMs, validated.issues[0].commit.durationMs, 16));
  assert.equal(reactIssueSeverity(40, 100, 16), 'high');
  assert.equal(reactIssueSeverity(16, 100, 16), 'medium');
  assert.equal(reactIssueSeverity(3, 100, 16), 'low');
  const prompt = buildReactFixPrompt(validated.issues[0]);
  assert.match(prompt, /^## Issue and Impact/);
  assert.match(prompt, /## Where this originates/);
  assert.match(prompt, /no source path or render trigger was recorded/);
  assert.doesNotMatch(prompt, /first.?paint|mount/i);
});

test('component findings from one commit are grouped with exact self times and remaining work', async t => {
  const data = syntheticProfile([272], ['Parent', 'SiblingA', 'SiblingB']);
  data.dataForRoots[0].commitData[0].fiberSelfDurations = [[2, 29], [3, 142], [4, 101]];
  const result = await loadEvidence(await profileFile(t, data));
  const commit = result.evidence.commits[0];
  const report = {
    noIssue: false,
    issues: ['1:3', '1:4'].map(componentId => ({
      componentId,
      commits: [{ rootID: commit.rootID, commitIndex: commit.commitIndex }],
    })),
  };
  const validated = validateReactIssueReport(report, result.evidence, 16);
  assert.equal(validated.issues.length, 1);
  assert.equal(validated.issues[0].commit.durationMs, 272);
  assert.deepEqual(validated.issues[0].components.map(component => [component.component, component.selfTimeMs]), [
    ['SiblingA', 142], ['SiblingB', 101],
  ]);
  assert.equal(reactIssueRemainingMs(validated.issues[0]), 29);
  assert.match(validated.issues[0].summary, /SiblingA and SiblingB/);
  const prompt = buildReactFixPrompt(validated.issues[0]);
  assert.match(prompt, /SiblingA: 142 ms self time/);
  assert.match(prompt, /SiblingB: 101 ms self time/);
});

test('legacy saved component findings are upgraded into commit groups', () => {
  const commit = { rootID: 1, commitIndex: 2, timestampMs: 100, durationMs: 272 };
  const legacy = ['SiblingA', 'SiblingB'].map((component, index) => ({
    id: `react-issue-${index + 1}`,
    summary: `Expensive render work in ${component}`,
    severity: 'high',
    evidence: `${component} used measured self time.`,
    commits: [commit],
    componentId: `1:${index + 3}`,
    component,
    selfTimeMs: index === 0 ? 142 : 101,
    percentOfCommit: index === 0 ? 52.2 : 37.1,
  }));
  const upgraded = normalizeStoredReactIssues(legacy);
  assert.equal(upgraded.length, 1);
  assert.equal(upgraded[0].id, 'react-commit-1-2');
  assert.deepEqual(upgraded[0].components.map(component => component.selfTimeMs), [142, 101]);
  assert.equal(reactIssueRemainingMs(upgraded[0]), 29);
});

test('evidence validation rejects corrupt summaries, references and measurements', async () => {
  const { evidence } = await loadEvidence();
  for (const edit of [
    e => e.summary.peakCommitDurationMs = 0,
    e => e.summary.totalCommitRenderDurationMs = 0,
    e => e.commits[0].durationMs = 999,
    e => e.commits[0].components[0].id = 'invented',
    e => e.commits[0].components[0].selfDurationMs = -1,
    e => e.omittedCommitCount = 99,
    e => e.componentsByRenderCount[0].avgActualDurationMs = 999,
  ]) {
    const raw = structuredClone(evidence); edit(raw);
    assert.throws(() => validateReactEvidence(raw, null), { status: 502 });
  }
});

test('HTTP empty ranking succeeds, budget is forwarded, and cheap profiles have zero model usage', async t => {
  const root = await temporary(t);
  const handler = createReactAnalysisHandler({ extract: extractReactProfile, temporaryRoot: root, analyze: async (result, cwd, budget) => {
    assert.equal(budget, 8.33);
    assert.equal(result.components.length, 0);
    return { ...emptyReport, usage };
  } });
  for (const budget of [8.33, 100]) {
    const response = await handler(request(await readFile(fixture), { minAvgDurationMs: 1000, frameBudgetMs: budget }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.components, undefined);
    assert.deepEqual(body.issues, []);
    assert.equal(body.noIssue, true);
    assert.equal(body.frameBudgetMs, budget);
    assert.equal(body.usage.totalTokens, budget === 100 ? 0 : 2);
    assert.deepEqual(await readdir(root), []);
  }
});

test('zero commits is insufficient evidence, and invalid budgets fail before analysis', async t => {
  const root = await temporary(t);
  const handler = createReactAnalysisHandler({ extract: extractReactProfile, temporaryRoot: root, analyze: async () => assert.fail('model must not run') });
  const response = await handler(request(JSON.stringify(syntheticProfile([]))));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /no React commits/);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1ms', '']) {
    const form = new FormData(); form.set('frameBudgetMs', value);
    assert.throws(() => parseFrameBudget(form), { status: 400 });
    assert.equal((await handler(request(await readFile(fixture), { frameBudgetMs: value }))).status, 400);
  }
  assert.equal(parseFrameBudget(new FormData()), 16);
  assert.deepEqual(await readdir(root), []);
});

test('verbose evidence keeps model input bounded and marks omitted detail', async t => {
  const data = syntheticProfile(Array(60).fill(30), Array.from({ length: 20 }, (_, i) => `${i}${'N'.repeat(500)}`));
  for (const commit of data.dataForRoots[0].commitData) {
    commit.changeDescriptions = commit.fiberActualDurations.map(([id]) => [id, {
      props: Array.from({ length: 30 }, (_, i) => `${i}${'p'.repeat(500)}`),
      hooks: Array.from({ length: 30 }, (_, i) => `${i}${'h'.repeat(500)}`),
    }]);
    commit.updaters = Array.from({ length: 30 }, () => ({ displayName: 'U'.repeat(500) }));
  }
  const result = await loadEvidence(await profileFile(t, data), defaults);
  const prompt = reactAnalystPrompt(result);
  assert.ok(prompt.length <= 200000);
  const payload = JSON.parse(prompt);
  assert.equal(payload.textTruncated, true);
  assert.equal(payload.commits.length, 50);
  assert.equal(payload.summary.commitCount, 60);
  assert.equal(payload.componentsByTotalSelfDuration, undefined);
  assert.ok(payload.commits[0].omittedComponentCount >= 10);
});

test('recorded change evidence retains causes and field names without inventing absent reasons', async t => {
  const data = syntheticProfile([30, 25]);
  data.dataForRoots[0].commitData[1].changeDescriptions = [[2, { context: true }], [3, { didHooksChange: true, hooks: [1], props: ['items'], state: ['value'] }]];
  const result = await loadEvidence(await profileFile(t, data));
  const commit = result.evidence.commits.find(c => c.commitIndex === 1);
  assert.deepEqual(commit.components.find(c => c.id === '1:2').causes, ['context-changed']);
  const changed = commit.components.find(c => c.id === '1:3');
  assert.deepEqual(changed.changedHooks, ['1']);
  assert.deepEqual(changed.changedProps, ['items']);
  assert.equal(changed.stateChanged, true);
  assert.deepEqual(commit.components.find(c => c.id === '1:4').causes, ['unknown']);
  const bad = structuredClone(data);
  bad.dataForRoots[0].commitData[1].changeDescriptions = [[2, { props: 'invalid' }]];
  await assert.rejects(loadEvidence(await profileFile(t, bad)), { status: 400 });
});

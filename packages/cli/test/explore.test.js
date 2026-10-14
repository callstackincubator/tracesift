import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explore, parseCommit, parseTaskIndex, readExploreAnalysis } from '../src/explore.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'tracesift-explore-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const analysisPath = join(home, 'analysis.json');
  await writeFile(analysisPath, JSON.stringify({
    apiVersion: 1, analysisId: 'analysis-1', profileType: 'cpu',
    cards: [{ taskIndex: 4, culprits: [{ nodeId: 'hot-node' }], boundaryFrames: [] }],
  }));
  await writeFile(join(home, 'service.json'), JSON.stringify({
    apiVersion: 1, version: '1.0.0', pid: process.pid, childPid: process.pid,
    instance: 'instance-1', baseUrl: 'http://127.0.0.1:4321', token: 'integration-token-long-enough', startedAt: Date.now(),
  }), { mode: 0o600 });
  return { home, analysisPath };
}

test('Explore reads a compact analysis and opens a selected function without loading its task tree', async t => {
  const { home, analysisPath } = await fixture(t);
  const opened = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4321/api/integration/v1/health');
    assert.equal(options.headers.Authorization, 'Bearer integration-token-long-enough');
    return Response.json({ apiVersion: 1, instance: 'instance-1' });
  };
  const url = await explore(analysisPath, { task: '4', focus: 'hot-node', home, fetchImpl, browser: value => opened.push(value) });
  assert.equal(url, 'http://127.0.0.1:4321/explore?a=analysis-1&task=4&focus=hot-node');
  assert.deepEqual(opened, [url]);
});

test('Explore validates the analysis, task and selected function', async t => {
  const { analysisPath } = await fixture(t);
  assert.equal((await readExploreAnalysis(analysisPath)).analysisId, 'analysis-1');
  assert.equal(parseTaskIndex('0'), 0);
  assert.throws(() => parseTaskIndex('-1'), /non-negative integer/);
  await assert.rejects(explore(analysisPath, { task: '2' }), /not present/);
  await assert.rejects(explore(analysisPath, { task: '4', focus: 'unknown' }), /function is not present/);
});

test('Explore reports a system browser launch failure', async t => {
  const { home, analysisPath } = await fixture(t);
  const fetchImpl = async () => Response.json({ apiVersion: 1, instance: 'instance-1' });
  await assert.rejects(explore(analysisPath, { task: '4', home, fetchImpl, browser: async () => false }), /Could not open a browser/);
});

test('Explore opens a selected React commit', async t => {
  const { home, analysisPath } = await fixture(t);
  await writeFile(analysisPath, JSON.stringify({
    apiVersion: 1, analysisId: 'analysis-1', profileType: 'react',
    cards: [{ rootId: 7, commitIndex: 12 }],
  }));
  assert.deepEqual(parseCommit('7.12'), { rootId: 7, commitIndex: 12 });
  assert.throws(() => parseCommit('7'), /root id and commit index/);
  const url = await explore(analysisPath, {
    commit: '7.12', home,
    fetchImpl: async () => Response.json({ apiVersion: 1, instance: 'instance-1' }),
    browser: async () => true,
  });
  assert.equal(url, 'http://127.0.0.1:4321/explore?a=analysis-1&commit=7.12');
  await assert.rejects(explore(analysisPath, { commit: '7.13' }), /not present/);
});

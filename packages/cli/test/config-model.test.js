import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deleteConfig, isAsciiApiKey, readConfig, writeConfig } from '../src/config.js';
import { getCatalog } from '../src/models.js';
import { selectModel, Cancelled } from '../src/model.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'perf-ai-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const config = { version: 1, provider: 'apex', model: 'callstack/Apex', keys: { apex: 'secret-test-key' } };

test('configuration validates, writes privately, and preserves old data on invalid writes', async t => {
  const dir = await home(t);
  assert.equal(await readConfig(dir), null);
  await writeConfig(config, dir);
  assert.deepEqual(await readConfig(dir), config);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'config.json'))).mode & 0o777, 0o600);
  await assert.rejects(writeConfig({ ...config, provider: 'other' }, dir), /Invalid/);
  assert.equal(isAsciiApiKey('sk-ant-api03-abcdefgh'), true);
  assert.equal(isAsciiApiKey('sk-ant-api03-abcd\u2014efgh'), false);
  await assert.rejects(
    writeConfig({ ...config, keys: { apex: 'secret-test-key\u2014dash' } }, dir),
    /plain ASCII/,
  );
  assert.deepEqual(await readConfig(dir), config);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ ...config, keys: { apex: 'secret-test-key\u2014dash' } }));
  await assert.rejects(readConfig(dir), /plain ASCII/);
  await writeConfig(config, dir);
  await writeFile(join(dir, 'config.json'), '{ secret-test-key');
  await assert.rejects(readConfig(dir), error => !error.message.includes('secret-test-key') && /Invalid/.test(error.message));
  await deleteConfig(dir);
  assert.equal(await readConfig(dir), null);
});

test('offline catalog contains only supported providers and native adapters', async () => {
  const models = await getCatalog();
  assert.deepEqual([...new Set(models.map(m => m.provider))].sort(), ['anthropic', 'apex', 'openai']);
  assert(models.some(m => m.provider === 'openai' && m.api === 'openai-responses'));
  assert(models.some(m => m.provider === 'anthropic' && m.api === 'anthropic-messages'));
  assert.equal(models.find(m => m.provider === 'apex').id, 'callstack/Apex');
});

test('picker reuses a saved key, searches, and cancellation leaves config untouched', async t => {
  const dir = await home(t);
  await writeConfig(config, dir);
  const answers = ['3', 'apex', '1', ''];
  let closed = false;
  await selectModel({ home: dir, catalog: [{ provider: 'apex', id: 'callstack/Apex', name: 'Apex' }], prompt: { ask: async () => answers.shift(), close() { closed = true; } } });
  assert(closed);
  assert.deepEqual(await readConfig(dir), config);
  const before = await readFile(join(dir, 'config.json'), 'utf8');
  await assert.rejects(selectModel({ home: dir, catalog: [], prompt: { ask: async () => { throw new Cancelled(); }, close() {} } }), Cancelled);
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), before);
});

test('startup freezes configured, missing and malformed states before first agent access', async t => {
  for (const initial of ['configured', 'missing', 'malformed']) {
    const dir = await home(t);
    if (initial === 'configured') await writeConfig(config, dir);
    if (initial === 'malformed') await writeFile(join(dir, 'config.json'), 'broken');
    const script = `
      import assert from 'node:assert/strict';
      import { initializeRuntime, getModelStatus, getConfiguredRuntime } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
      import { writeConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
      await initializeRuntime();
      const before = await getModelStatus();
      await writeConfig(${JSON.stringify({ ...config, model: 'invalid' })});
      assert.deepEqual(await getModelStatus(), before);
      assert(!JSON.stringify(before).includes('secret-test-key'));
      if (before.configured) { const {runtime,model} = await getConfiguredRuntime(); assert.equal(model.id,'callstack/Apex'); assert.equal((await runtime.getAuth(model)).auth.apiKey,'secret-test-key'); }
      else await assert.rejects(getConfiguredRuntime());
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PERF_AI_HOME: dir } });
  }
});

test('runtime selects each provider adapter and injects only the saved runtime key', async t => {
  const catalog = await getCatalog();
  for (const provider of ['openai', 'anthropic', 'apex']) {
    const dir = await home(t);
    const selected = catalog.find(m => m.provider === provider);
    await writeConfig({ version: 1, provider, model: selected.id, keys: { [provider]: 'saved-test-key' } }, dir);
    const script = `
      import assert from 'node:assert/strict';
      import {getConfiguredRuntime} from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
      const {runtime,model} = await getConfiguredRuntime();
      assert.equal(model.provider, ${JSON.stringify(provider)});
      assert.equal(model.api, ${JSON.stringify(selected.api)});
      assert.equal((await runtime.getAuth(model)).auth.apiKey, 'saved-test-key');
      assert.equal(runtime.getRegisteredProviderIds().includes('unrelated-custom-provider'), false);
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PERF_AI_HOME: dir, OPENAI_API_KEY: 'ambient-must-not-win', ANTHROPIC_API_KEY: 'ambient-must-not-win' } });
  }
});

test('runtime model settings expose no secrets and apply UI configuration immediately', async t => {
  const dir = await home(t);
  const script = `
    import assert from 'node:assert/strict';
    import { clearModelConfiguration, configureModel, getConfiguredRuntime, getModelSettings } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const before = await getModelSettings();
    assert.equal(before.configured, false);
    assert.equal(before.providers.length, 3);
    assert(!JSON.stringify(before).includes('saved-from-ui'));
    const selected = before.providers.find(provider => provider.id === 'apex').models[0];
    const after = await configureModel({ provider: 'apex', model: selected.id, apiKey: 'saved-from-ui' });
    assert.equal(after.configured, true);
    assert.equal(after.providerId, 'apex');
    assert.equal(after.modelId, selected.id);
    assert.equal(after.providers.find(provider => provider.id === 'apex').keyConfigured, true);
    assert(!JSON.stringify(after).includes('saved-from-ui'));
    const { runtime, model } = await getConfiguredRuntime();
    assert.equal(model.id, selected.id);
    assert.equal((await runtime.getAuth(model)).auth.apiKey, 'saved-from-ui');
    const cleared = await clearModelConfiguration();
    assert.equal(cleared.configured, false);
    assert.equal(cleared.providerId, undefined);
    assert(cleared.providers.every(provider => provider.keyConfigured === false));
    await assert.rejects(getConfiguredRuntime(), /Analysis settings/);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PERF_AI_HOME: dir } });
});

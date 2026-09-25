import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deleteConfig, isAsciiApiKey, readConfig, writeConfig } from '../src/config.js';
import { getCatalog } from '../src/models.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'tracesift-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const config = { version: 2, provider: 'apex', model: 'callstack/Apex', authMode: 'api_key', keys: { apex: 'secret-test-key' } };

test('configuration validates, writes privately, and preserves old data on invalid writes', async t => {
  const dir = await home(t);
  assert.equal(await readConfig(dir), null);
  await writeConfig(config, dir);
  assert.deepEqual(await readConfig(dir), config);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ version: 1, provider: 'apex', model: 'callstack/Apex', keys: { apex: 'secret-test-key', openai: 'other-key' } }));
  assert.deepEqual(await readConfig(dir), { ...config, keys: { apex: 'secret-test-key', openai: 'other-key' } });
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).version, 2);
  await writeConfig(config, dir);
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
  assert.deepEqual([...new Set(models.map(m => m.provider))].sort(), ['anthropic', 'apex', 'openai', 'openai-codex']);
  assert(models.some(m => m.provider === 'openai-codex' && m.api === 'openai-codex-responses'));
  assert(models.some(m => m.provider === 'openai' && m.api === 'openai-responses'));
  assert(models.some(m => m.provider === 'anthropic' && m.api === 'anthropic-messages'));
  assert.equal(models.find(m => m.provider === 'apex').id, 'callstack/Apex');
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
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TRACE_SIFT_HOME: dir } });
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
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TRACE_SIFT_HOME: dir, OPENAI_API_KEY: 'ambient-must-not-win', ANTHROPIC_API_KEY: 'ambient-must-not-win' } });
  }
});

test('runtime model settings expose no secrets and apply UI configuration immediately', async t => {
  const dir = await home(t);
  const script = `
    import assert from 'node:assert/strict';
    import { clearModelConfiguration, configureModel, getConfiguredRuntime, getModelSettings } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const before = await getModelSettings();
    assert.equal(before.configured, false);
    assert.equal(before.providers.length, 4);
    assert(!JSON.stringify(before).includes('saved-from-ui'));
    const selected = before.providers.find(provider => provider.id === 'apex').models[0];
    const after = await configureModel({ provider: 'apex', model: selected.id, apiKey: 'saved-from-ui' });
    assert.equal(after.configured, true);
    assert.equal(after.providerId, 'apex');
    assert.equal(after.modelId, selected.id);
    assert.equal(after.providers.find(provider => provider.id === 'apex').authMethods.find(method => method.type === 'api_key').configured, true);
    assert(!JSON.stringify(after).includes('saved-from-ui'));
    const { runtime, model } = await getConfiguredRuntime();
    assert.equal(model.id, selected.id);
    assert.equal((await runtime.getAuth(model)).auth.apiKey, 'saved-from-ui');
    const cleared = await clearModelConfiguration();
    assert.equal(cleared.configured, false);
    assert.equal(cleared.providerId, undefined);
    assert(cleared.providers.every(provider => provider.authMethods.every(method => method.configured === false)));
    await assert.rejects(getConfiguredRuntime(), /Analysis settings/);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TRACE_SIFT_HOME: dir } });
});

test('OAuth mode uses only TraceSift credentials and preserves unrelated API keys', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'trace-oauth-token', refresh: 'trace-refresh-token', expires: Date.now() + 36000000, accountId: 'private-account' }, anthropic: { type: 'oauth', access: 'claude-oauth-token', refresh: 'claude-refresh-token', expires: Date.now() + 36000000 } }), { mode: 0o600 });
  await writeConfig({ version: 2, provider: 'anthropic', model: (await getCatalog()).find(m => m.provider === 'anthropic').id, authMode: 'api_key', keys: { openai: 'saved-openai-key', anthropic: 'saved-anthropic-key' } }, dir);
  const script = `
    import assert from 'node:assert/strict';
    import { readConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
    import { configureModel, getConfiguredRuntime, getModelSettings, clearModelConfiguration } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const before = await getModelSettings();
    const codex = before.providers.find(item => item.id === 'openai-codex');
    assert.equal(codex.authMethods.length, 1);
    assert.equal(codex.authMethods[0].configured, true);
    assert.equal(before.providers.find(item => item.id === 'anthropic').authMethods.find(method => method.type === 'oauth').configured, true);
    assert.equal((await (await getConfiguredRuntime()).runtime.getAuth((await getConfiguredRuntime()).model)).auth.apiKey, 'saved-anthropic-key');
    assert(!JSON.stringify(before).includes('trace-oauth-token'));
    assert(!JSON.stringify(before).includes('private-account'));
    await configureModel({ provider: 'openai-codex', model: codex.models[0].id, authMode: 'oauth' });
    const config = await readConfig();
    assert.deepEqual(config.keys, { openai: 'saved-openai-key', anthropic: 'saved-anthropic-key' });
    const { runtime, model } = await getConfiguredRuntime();
    assert.equal((await runtime.getAuth(model)).auth.apiKey, 'trace-oauth-token');
    const claude = before.providers.find(item => item.id === 'anthropic');
    await configureModel({ provider: 'anthropic', model: claude.models[0].id, authMode: 'oauth' });
    const selectedClaude = await getConfiguredRuntime();
    assert.equal((await selectedClaude.runtime.getAuth(selectedClaude.model)).auth.apiKey, 'claude-oauth-token');
    await clearModelConfiguration();
    assert.equal((await getModelSettings()).providers.find(item => item.id === 'openai-codex').authMethods[0].configured, false);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TRACE_SIFT_HOME: dir, OPENAI_API_KEY: 'ambient-key' } });
});

test('clear-all removes OAuth credentials even when config is malformed', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'config.json'), '{ malformed');
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'codex-private-token', refresh: 'codex-private-refresh', expires: Date.now() + 36000000, accountId: 'private-account' },
    anthropic: { type: 'oauth', access: 'claude-private-token', refresh: 'claude-private-refresh', expires: Date.now() + 36000000 },
  }), { mode: 0o600 });
  const script = `
    import assert from 'node:assert/strict';
    import { readStoredCredential } from '@earendil-works/pi-coding-agent';
    import { join } from 'node:path';
    import { initializeRuntime, clearModelConfiguration } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    import { readConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
    const before = await initializeRuntime();
    assert.equal(before.status.configured, false);
    assert(before.runtime);
    assert(!JSON.stringify(before.status).includes('private-token'));
    const after = await clearModelConfiguration();
    assert.equal(after.configured, false);
    assert.equal(await readConfig(), null);
    const authPath = join(process.env.TRACE_SIFT_HOME, 'auth.json');
    assert.equal(readStoredCredential('openai-codex', authPath), undefined);
    assert.equal(readStoredCredential('anthropic', authPath), undefined);
    assert(after.providers.every(provider => provider.authMethods.every(method => !method.configured)));
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TRACE_SIFT_HOME: dir } });
});

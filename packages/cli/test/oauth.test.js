import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelOAuth, getOAuthAttempt, inputOAuth, startOAuth } from '../src/oauth.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser sign-in exposes only safe status and accepts manual code', async () => {
  let selected;
  const runtime = { login: async (_provider, _type, interaction) => {
    selected = await interaction.prompt({ type: 'select', options: [{ id: 'browser', label: 'Browser' }] });
    interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize?client_id=public&code=true', instructions: 'secret-provider-response' });
    const answer = await interaction.prompt({ type: 'manual_code', message: 'secret-provider-response' });
    assert.equal(answer, 'code-value');
    return { type: 'oauth', access: 'access-secret', refresh: 'refresh-secret' };
  } };
  const started = await startOAuth('openai-codex', 'browser', async () => runtime, 1000, async () => {});
  await tick();
  assert.equal(selected, 'browser');
  const pending = getOAuthAttempt(started.attemptId);
  assert.equal(pending.event.type, 'auth_url');
  assert(pending.event.url.includes('code=true'));
  assert.equal(pending.prompt.type, 'manual_code');
  assert(!JSON.stringify(pending).includes('secret'));
  await assert.rejects(startOAuth('openai-codex', 'browser', async () => runtime), error => error.status === 409);
  inputOAuth(started.attemptId, 'code-value');
  await tick();
  assert.equal(getOAuthAttempt(started.attemptId).status, 'complete');
});

test('device-code sign-in maps code and supports cancellation', async () => {
  let selected;
  const runtime = { login: async (_provider, _type, interaction) => {
    selected = await interaction.prompt({ type: 'select', options: [] });
    interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' });
    await new Promise((_resolve, reject) => interaction.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } };
  const started = await startOAuth('openai-codex', 'device_code', async () => runtime, 1000, async () => {});
  await tick();
  assert.equal(selected, 'device_code');
  assert.equal(getOAuthAttempt(started.attemptId).event.userCode, 'ABCD-1234');
  assert.equal(cancelOAuth(started.attemptId).status, 'cancelled');
});

test('timeout and provider errors are sanitized', async () => {
  const hanging = { login: async (_provider, _type, interaction) => new Promise((_resolve, reject) => interaction.signal.addEventListener('abort', () => reject(new Error('raw-token-secret')), { once: true })) };
  const timed = await startOAuth('anthropic', 'browser', async () => hanging, 10, async () => {});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(getOAuthAttempt(timed.attemptId).status, 'timed_out');
  const failing = { login: async () => { throw new Error('raw-token-secret'); } };
  const failed = await startOAuth('anthropic', 'browser', async () => failing, 1000, async () => {});
  await tick();
  assert.equal(getOAuthAttempt(failed.attemptId).status, 'failed');
  assert(!JSON.stringify(getOAuthAttempt(failed.attemptId)).includes('raw-token-secret'));
});

test('concurrent starts reserve the provider before runtime loads', async () => {
  let release;
  const runtimeFactory = () => new Promise(resolve => { release = () => resolve({ login: async (_provider, _type, interaction) => new Promise((_done, reject) => interaction.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) }); });
  const first = startOAuth('anthropic', 'browser', runtimeFactory, 1000, async () => {});
  await assert.rejects(startOAuth('anthropic', 'browser', runtimeFactory), error => error.status === 409);
  release();
  const started = await first;
  cancelOAuth(started.attemptId);
});

test('completion waits for local refresh and reports refresh failure without leaking errors', async () => {
  let releaseRefresh;
  const runtime = { login: async () => ({ type: 'oauth', access: 'private-token', refresh: 'private-refresh' }) };
  const started = await startOAuth('anthropic', 'browser', async () => runtime, 1000, () => new Promise(resolve => { releaseRefresh = resolve; }));
  await tick();
  assert.equal(getOAuthAttempt(started.attemptId).status, 'pending');
  assert.equal(typeof releaseRefresh, 'function');
  releaseRefresh();
  await tick();
  assert.equal(getOAuthAttempt(started.attemptId).status, 'complete');

  const failed = await startOAuth('anthropic', 'browser', async () => runtime, 1000, async () => { throw new Error('private-token in raw settings error'); });
  await tick();
  const result = getOAuthAttempt(failed.attemptId);
  assert.equal(result.status, 'failed');
  assert(!JSON.stringify(result).includes('private-token'));
});

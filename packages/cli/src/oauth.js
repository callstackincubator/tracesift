import { randomUUID } from 'node:crypto';
import { getOAuthRuntime, refreshConfiguredRuntime } from './runtime.js';

const ACTIVE_MS = 10 * 60 * 1000;
const RETAIN_MS = 10 * 60 * 1000;
const shared = globalThis[Symbol.for('tracesift.oauth-attempts.v1')] ??= { attempts: new Map() };

export class OAuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function publicAttempt(attempt) {
  const { id: attemptId, provider, status, event, prompt, error, expiresAt } = attempt;
  return { attemptId, provider, status, event, prompt, error, expiresAt };
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || [...url.searchParams].some(([key, value]) => /^(access_token|refresh_token|id_token|account_id)$/i.test(key) || (key.toLowerCase() === 'code' && value !== 'true'))) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function safeEvent(event) {
  if (event?.type === 'auth_url') return { type: 'auth_url', url: safeUrl(event.url), instructions: 'Complete sign-in in your browser.' };
  if (event?.type === 'device_code') return { type: 'device_code', userCode: String(event.userCode).slice(0, 64), verificationUri: safeUrl(event.verificationUri), intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds };
  if (event?.type === 'progress') return { type: 'progress', message: 'Waiting for sign-in to complete…' };
  return { type: 'progress', message: 'Waiting for sign-in to complete…' };
}
function finish(attempt, status, error) {
  if (attempt.status !== 'pending') return;
  attempt.status = status;
  attempt.error = error;
  attempt.prompt = undefined;
  attempt.answer = undefined;
  clearTimeout(attempt.timeout);
  attempt.retain = setTimeout(() => shared.attempts.delete(attempt.id), RETAIN_MS);
  attempt.retain.unref?.();
}
function find(id) {
  const attempt = shared.attempts.get(id);
  if (!attempt) throw new OAuthError(404, 'Sign-in attempt not found.');
  return attempt;
}
export function getOAuthAttempt(id) { return publicAttempt(find(id)); }
export async function startOAuth(provider, method = 'browser', runtimeFactory = getOAuthRuntime, timeoutMs = ACTIVE_MS, afterLogin = refreshConfiguredRuntime) {
  if (!['openai-codex', 'anthropic'].includes(provider) || !['browser', 'device_code'].includes(method) || (provider === 'anthropic' && method !== 'browser')) throw new OAuthError(400, 'Choose a supported sign-in method.');
  if ([...shared.attempts.values()].some(item => item.provider === provider && item.status === 'pending')) throw new OAuthError(409, 'Sign-in is already in progress for this provider.');
  const controller = new AbortController();
  const attempt = { id: randomUUID(), provider, status: 'pending', event: undefined, prompt: undefined, error: undefined, answer: undefined, controller, expiresAt: Date.now() + timeoutMs };
  shared.attempts.set(attempt.id, attempt);
  attempt.timeout = setTimeout(() => { controller.abort(); finish(attempt, 'timed_out', 'Sign-in timed out. Try again.'); }, timeoutMs);
  attempt.timeout.unref?.();
  let runtime;
  try { runtime = await runtimeFactory(); }
  catch { finish(attempt, 'failed', 'Sign-in could not start. Try again.'); return publicAttempt(attempt); }
  void runtime.login(provider, 'oauth', {
    signal: controller.signal,
    notify: event => { if (attempt.status === 'pending') attempt.event = safeEvent(event); },
    prompt: prompt => {
      if (prompt.type === 'select' && provider === 'openai-codex') return Promise.resolve(method === 'device_code' ? 'device_code' : 'browser');
      if (prompt.type !== 'manual_code') return Promise.reject(new Error('Unsupported sign-in prompt'));
      if (attempt.status !== 'pending') return Promise.reject(new Error('Sign-in cancelled'));
      attempt.prompt = { type: 'manual_code', message: 'Paste the authorization code or final redirect URL if browser sign-in does not finish automatically.' };
      return new Promise((resolve, reject) => {
        const abort = () => { attempt.answer = undefined; reject(new Error('Sign-in cancelled')); };
        attempt.answer = value => { prompt.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abort); resolve(value); };
        prompt.signal?.addEventListener('abort', abort, { once: true });
        controller.signal.addEventListener('abort', abort, { once: true });
      });
    },
  }).then(async () => {
    if (attempt.status !== 'pending') return;
    await afterLogin();
    if (attempt.status === 'pending') finish(attempt, 'complete');
  }).catch(() => {
    if (attempt.status === 'pending') finish(attempt, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'Sign-in cancelled.' : 'Sign-in failed or local settings could not refresh. Try again.');
  });
  return publicAttempt(attempt);
}
export function inputOAuth(id, value) {
  const attempt = find(id);
  if (attempt.status !== 'pending' || !attempt.answer) throw new OAuthError(409, 'This sign-in attempt is not waiting for a code.');
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new OAuthError(400, 'Enter the authorization code or redirect URL.');
  const answer = attempt.answer;
  attempt.answer = undefined;
  attempt.prompt = undefined;
  answer(value.trim());
  return publicAttempt(attempt);
}
export function cancelOAuth(id) {
  const attempt = find(id);
  if (attempt.status === 'pending') { attempt.controller.abort(); finish(attempt, 'cancelled', 'Sign-in cancelled.'); }
  return publicAttempt(attempt);
}
export function cancelAllOAuth() {
  for (const attempt of shared.attempts.values()) if (attempt.status === 'pending') cancelOAuth(attempt.id);
}
export async function logoutOAuth(provider, runtimeFactory = getOAuthRuntime) {
  if (!['openai-codex', 'anthropic'].includes(provider)) throw new OAuthError(400, 'Choose a supported provider.');
  for (const attempt of shared.attempts.values()) if (attempt.provider === provider && attempt.status === 'pending') cancelOAuth(attempt.id);
  await (await runtimeFactory()).logout(provider);
  return refreshConfiguredRuntime();
}

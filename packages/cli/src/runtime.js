import { deleteConfig, readConfig, writeConfig, providers, getHome, isAsciiApiKey } from './config.js';
import { createModelRuntime, getCatalog } from './models.js';
import { join } from 'node:path';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';

function hasStoredOAuth(provider) {
  try { return readStoredCredential(provider, join(getHome(), 'auth.json'))?.type === 'oauth'; }
  catch { return false; }
}

// Workspace packages may be bundled by Next.js even with serverExternalPackages.
// Share the startup promise across instrumentation and route module graphs.
/** @type {{startup?: ReturnType<typeof loadRuntime>}} */
const shared = globalThis[Symbol.for('tracesift.model-runtime.v1')] ??= {};
export function initializeRuntime() {
  return shared.startup ??= loadRuntime();
}
async function loadRuntime() {
    let runtime;
    try {
      runtime = await createModelRuntime();
      const config = await readConfig();
      if (!config) return { runtime, status: { configured: false, error: 'Choose a model in Analysis settings.' } };
      const model = runtime.getModel(config.provider, config.model);
      if (!model) throw new Error('The selected model is unavailable. Choose another model in Analysis settings.');
      if (config.authMode === 'api_key') await runtime.setRuntimeApiKey(config.provider, config.keys[config.provider]);
      else {
        await runtime.removeRuntimeApiKey(config.provider);
        if (!hasStoredOAuth(config.provider)) throw new Error('Connect your subscription in Analysis settings.');
      }
      return { runtime, model, status: { configured: true, providerId: config.provider, modelId: model.id, authMode: config.authMode, provider: providers[config.provider], model: model.name }, agentDir: join(getHome(), 'agent') };
    } catch (error) {
      return { runtime, status: { configured: false, error: error instanceof Error ? error.message : 'Could not load model settings.' } };
    }
}
export async function getModelStatus() { return (await initializeRuntime()).status; }
export async function getModelSettings() {
  const [state, catalog] = await Promise.all([initializeRuntime(), getCatalog()]);
  const status = state.status;
  let config;
  try { config = await readConfig(); } catch { /* Invalid configuration can be replaced from the UI. */ }
  return {
    ...status,
    providerId: config?.provider,
    modelId: config?.model,
    authMode: config?.authMode,
    providers: Object.entries(providers).map(([id, name]) => ({
      id,
      name,
      authMethods: [
        ...(id !== 'openai-codex' ? [{ type: 'api_key', label: 'API key', configured: Boolean(config?.keys[id]), subscription: false }] : []),
        ...(['openai-codex', 'anthropic'].includes(id) ? [{ type: 'oauth', label: id === 'openai-codex' ? 'ChatGPT Plus / Pro' : 'Claude subscription', configured: hasStoredOAuth(id), subscription: true }] : []),
      ],
      models: catalog.filter(model => model.provider === id).map(model => ({ id: model.id, name: model.name })),
    })),
  };
}
export async function configureModel({ provider, model, authMode = 'api_key', apiKey }) {
  if (!Object.hasOwn(providers, provider)) throw new Error('Choose a supported provider.');
  const selected = (await getCatalog()).find(candidate => candidate.provider === provider && candidate.id === model);
  if (!selected) throw new Error('Choose a supported model.');
  let previous;
  try { previous = await readConfig(); } catch { /* Replacing an invalid configuration is allowed. */ }
  if (!['api_key', 'oauth'].includes(authMode) || (authMode === 'oauth' && !['openai-codex', 'anthropic'].includes(provider))) throw new Error('Choose a supported authentication method.');
  const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : previous?.keys[provider];
  if (authMode === 'api_key' && !key) throw new Error('Enter an API key for the selected provider.');
  if (key && !isAsciiApiKey(key)) throw new Error('API keys must be plain ASCII. Copy the key directly from the provider dashboard.');
  if (authMode === 'oauth' && !hasStoredOAuth(provider)) throw new Error('Connect your subscription before selecting this model.');
  await writeConfig({ version: 2, provider, model, authMode, keys: { ...previous?.keys, ...(apiKey?.trim() ? { [provider]: key } : {}) } });
  shared.startup = loadRuntime();
  const state = await shared.startup;
  if (!state.status.configured) throw new Error(state.status.error);
  return getModelSettings();
}
export async function clearModelConfiguration() {
  (await import('./oauth.js')).cancelAllOAuth();
  const runtime = (await initializeRuntime()).runtime;
  if (runtime) for (const provider of ['openai-codex', 'anthropic']) await runtime.logout(provider);
  await deleteConfig();
  shared.startup = loadRuntime();
  await shared.startup;
  return getModelSettings();
}
export async function getOAuthRuntime() {
  const state = await initializeRuntime();
  if (!state.runtime) throw new Error('Authentication is unavailable.');
  return state.runtime;
}
export async function refreshConfiguredRuntime() {
  shared.startup = loadRuntime();
  await shared.startup;
  return getModelSettings();
}
export async function getConfiguredRuntime() {
  const state = await initializeRuntime();
  if (!state.runtime || !state.model) throw new Error(state.status.error);
  return state;
}

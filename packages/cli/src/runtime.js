import { deleteConfig, readConfig, writeConfig, providers, getHome, isAsciiApiKey } from './config.js';
import { createModelRuntime, getCatalog } from './models.js';
import { join } from 'node:path';

// Workspace packages may be bundled by Next.js even with serverExternalPackages.
// Share the startup promise across instrumentation and route module graphs.
/** @type {{startup?: ReturnType<typeof loadRuntime>}} */
const shared = globalThis[Symbol.for('perf-ai.model-runtime.v1')] ??= {};
export function initializeRuntime() {
  return shared.startup ??= loadRuntime();
}
async function loadRuntime() {
    try {
      const config = await readConfig();
      if (!config) return { status: { configured: false, error: 'Choose a model in Analysis settings.' } };
      const runtime = await createModelRuntime();
      const model = runtime.getModel(config.provider, config.model);
      if (!model) throw new Error('The selected model is unavailable. Choose another model in Analysis settings.');
      await runtime.setRuntimeApiKey(config.provider, config.keys[config.provider]);
      return { runtime, model, status: { configured: true, providerId: config.provider, modelId: model.id, provider: providers[config.provider], model: model.name }, agentDir: join(getHome(), 'agent') };
    } catch (error) {
      return { status: { configured: false, error: error.message } };
    }
}
export async function getModelStatus() { return (await initializeRuntime()).status; }
export async function getModelSettings() {
  const [status, catalog] = await Promise.all([getModelStatus(), getCatalog()]);
  let config;
  try { config = await readConfig(); } catch { /* Invalid configuration can be replaced from the UI. */ }
  return {
    ...status,
    providerId: config?.provider,
    modelId: config?.model,
    providers: Object.entries(providers).map(([id, name]) => ({
      id,
      name,
      keyConfigured: Boolean(config?.keys[id]),
      models: catalog.filter(model => model.provider === id).map(model => ({ id: model.id, name: model.name })),
    })),
  };
}
export async function configureModel({ provider, model, apiKey }) {
  if (!Object.hasOwn(providers, provider)) throw new Error('Choose a supported provider.');
  const selected = (await getCatalog()).find(candidate => candidate.provider === provider && candidate.id === model);
  if (!selected) throw new Error('Choose a supported model.');
  let previous;
  try { previous = await readConfig(); } catch { /* Replacing an invalid configuration is allowed. */ }
  const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : previous?.keys[provider];
  if (!key) throw new Error('Enter an API key for the selected provider.');
  if (!isAsciiApiKey(key)) throw new Error('API keys must be plain ASCII. Copy the key directly from the provider dashboard.');
  await writeConfig({ version: 1, provider, model, keys: { ...previous?.keys, [provider]: key } });
  shared.startup = loadRuntime();
  const state = await shared.startup;
  if (!state.status.configured) throw new Error(state.status.error);
  return getModelSettings();
}
export async function clearModelConfiguration() {
  await deleteConfig();
  shared.startup = loadRuntime();
  await shared.startup;
  return getModelSettings();
}
export async function getConfiguredRuntime() {
  const state = await initializeRuntime();
  if (!state.runtime || !state.model) throw new Error(state.status.error);
  return state;
}

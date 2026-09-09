import { readConfig, providers, getHome } from './config.js';
import { createModelRuntime } from './models.js';
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
      if (!config) return { status: { configured: false, error: 'Run perf-ai model, then restart the server.' } };
      const runtime = await createModelRuntime();
      const model = runtime.getModel(config.provider, config.model);
      if (!model) throw new Error('Selected model is unavailable. Run perf-ai model and restart the server.');
      await runtime.setRuntimeApiKey(config.provider, config.keys[config.provider]);
      return { runtime, model, status: { configured: true, provider: providers[config.provider], model: model.name }, agentDir: join(getHome(), 'agent') };
    } catch (error) {
      return { status: { configured: false, error: error.message } };
    }
}
export async function getModelStatus() { return (await initializeRuntime()).status; }
export async function getConfiguredRuntime() {
  const state = await initializeRuntime();
  if (!state.runtime || !state.model) throw new Error(state.status.error);
  return state;
}

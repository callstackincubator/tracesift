import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { providers } from './config.js';
export const APEX_PROVIDER_ID = 'apex';
export const APEX_MODEL_ID = 'callstack/Apex';
export function registerApexProvider(runtime) {
  runtime.registerProvider(APEX_PROVIDER_ID, {
    name: 'Apex', baseUrl: 'https://api.callstack.ai/v1', api: 'openai-completions', authHeader: true,
    models: [{ id: APEX_MODEL_ID, name: 'Apex', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 32000 }],
  });
}
export async function createModelRuntime() {
  // Runtime keys live only in the SDK overlay; persistent PI credentials are never loaded.
  const credentials = { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registerApexProvider(runtime);
  return runtime;
}
export async function getCatalog() {
  const runtime = await createModelRuntime();
  return runtime.getModels().filter(model => Object.hasOwn(providers, model.provider)).sort((a, b) => a.name.localeCompare(b.name));
}

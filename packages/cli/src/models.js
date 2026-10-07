import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { providers, getHome } from './config.js';
import { join } from 'node:path';
export const APEX_PROVIDER_ID = 'apex';
export const APEX_MODEL_ID = 'callstack/Apex';
export function registerApexProvider(runtime) {
  runtime.registerProvider(APEX_PROVIDER_ID, {
    name: 'Apex', baseUrl: 'https://api.callstack.ai/v1', api: 'openai-completions', authHeader: true,
    models: [{
      id: APEX_MODEL_ID,
      name: 'Apex',
      // Apex can return hidden reasoning tokens even when the caller asks for
      // no thinking. Declare that capability so the OpenAI-compatible adapter
      // sends an explicit reasoning effort instead of leaving the provider to
      // choose an unbounded default. Apex's lowest supported effort is `low`.
      reasoning: true,
      thinkingLevelMap: { off: 'low' },
      // Keep the system-message wire format that Apex already accepted; only
      // opt into the reasoning control needed for these bounded reports.
      compat: { supportsReasoningEffort: true, supportsDeveloperRole: false },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 32000,
    }],
  });
}
export async function createModelRuntime() {
  const runtime = await ModelRuntime.create({ authPath: join(getHome(), 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registerApexProvider(runtime);
  return runtime;
}
export async function getCatalog() {
  const runtime = await createModelRuntime();
  return runtime.getModels().filter(model => Object.hasOwn(providers, model.provider)).sort((a, b) => a.name.localeCompare(b.name));
}

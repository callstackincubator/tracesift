import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const APEX_PROVIDER_ID = "apex";
export const APEX_MODEL_ID = "callstack/Apex";

export function registerApexProvider(modelRuntime: ModelRuntime): void {
  modelRuntime.registerProvider(APEX_PROVIDER_ID, {
    name: "Apex",
    baseUrl: "https://api.callstack.ai/v1",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: APEX_MODEL_ID,
        name: "Apex",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        // 4096 truncated the agent's final tool call (a 12-item hotspot report
        // with stacks easily exceeds it) — give the agent real headroom.
        maxTokens: 32_000
      }
    ]
  });
}

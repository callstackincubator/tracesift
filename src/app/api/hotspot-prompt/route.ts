import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getRecord, type TokenUsage } from "@/lib/analysis";
import { AgentError, runAgent } from "@/lib/pi-agent";
import { buildFixPromptUserPrompt, FIX_PROMPT_SYSTEM_PROMPT } from "@/lib/prompts";

const LOG = "api/hotspot-prompt";

function log(...parts: unknown[]): void {
  console.log(`[perf-ai] ${new Date().toISOString()} [${LOG}]`, ...parts);
}

const submitPromptSchema = Type.Object({
  prompt: Type.String({
    description:
      "The full debugging prompt (markdown) a developer can paste into a coding AI agent. Must contain 'Where this originates' and 'Suggested fixes' sections.",
  }),
});

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { analysisId?: unknown; hotspotId?: unknown; apiKey?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Expected a JSON body with analysisId, hotspotId and apiKey." }, 400);
  }

  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const hotspotId = typeof body?.hotspotId === "string" ? body.hotspotId : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  if (!analysisId || !hotspotId) {
    return json({ error: "analysisId and hotspotId are required." }, 400);
  }
  if (!apiKey) {
    return json({ error: "A Callstack API key is required to generate the prompt." }, 400);
  }

  const record = getRecord(analysisId);
  if (!record) {
    return json({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
  }
  const hotspot = record.hotspots.find((entry) => entry.id === hotspotId);
  if (!hotspot) {
    return json({ error: "Unknown hotspot id for this analysis." }, 404);
  }

  const cached = record.prompts[hotspotId];
  if (cached) {
    log(`analysis=${analysisId} hotspot=${hotspotId}: serving cached prompt (${cached.length} chars)`);
    return json({ prompt: cached, usage: record.promptUsage[hotspotId] });
  }
  log(`analysis=${analysisId} hotspot=${hotspotId} ("${hotspot.title}", ${hotspot.selfTimeMs} ms): generating prompt`);

  const capture: { prompt?: string } = {};
  const submitTool: ToolDefinition = defineTool({
    name: "submit_prompt",
    label: "Submit prompt",
    description: "Submit the final debugging prompt for this hotspot. Call exactly once.",
    parameters: submitPromptSchema,
    execute: async (_toolCallId, params) => {
      const text = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (text) capture.prompt = text;
      return {
        content: [
          {
            type: "text",
            text: text
              ? "Prompt submitted. Task complete — reply with a one-line confirmation and stop."
              : "The prompt was empty. Call submit_prompt again with the full prompt text.",
          },
        ],
        details: { received: Boolean(text) },
      };
    },
  });

  let finalText = "";
  let usage: TokenUsage;
  try {
    ({ finalText, usage } = await runAgent({
      label: "hotspot-prompt",
      apiKey,
      systemPrompt: FIX_PROMPT_SYSTEM_PROMPT,
      prompt: buildFixPromptUserPrompt(hotspot, record),
      cwd: record.dir,
      customTools: [submitTool],
      timeoutMs: 300_000,
    }));
  } catch (error) {
    log(`agent run failed: ${error instanceof Error ? error.message : error}`);
    if (error instanceof AgentError) {
      return json({ error: error.message }, error.status);
    }
    console.error("[perf-ai] hotspot prompt failed", error);
    return json({ error: "Unexpected server error while generating the prompt." }, 500);
  }

  const prompt = (capture.prompt ?? finalText.trim())
    .replace(/^\s*```[a-z]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
  if (!prompt) {
    log("agent produced no prompt (tool not called and final text empty)");
    return json(
      { error: "The agent finished without producing a prompt. Try again.", detail: finalText.slice(0, 400) || undefined },
      502
    );
  }

  record.prompts[hotspotId] = prompt;
  record.promptUsage[hotspotId] = usage;
  log(`prompt generated in ${Math.round((Date.now() - startedAt) / 1000)}s (${prompt.length} chars, ${usage.totalTokens} tokens)`);
  return json({ prompt, usage });
}

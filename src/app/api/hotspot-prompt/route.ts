import { getRecord, getSavedAnalysis, updateSavedAnalysis, type TokenUsage } from "@/lib/analysis";
import { AgentError, runAgent } from "@/lib/pi-agent";
import { buildFixPromptUserPrompt, FIX_PROMPT_SYSTEM_PROMPT } from "@/lib/prompts";
import { tmpdir } from "node:os";

const LOG = "api/hotspot-prompt";

function log(...parts: unknown[]): void {
  console.log(`[perf-ai] ${new Date().toISOString()} [${LOG}]`, ...parts);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { analysisId?: unknown; hotspotId?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Expected a JSON body with analysisId and hotspotId." }, 400);
  }

  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const hotspotId = typeof body?.hotspotId === "string" ? body.hotspotId : "";

  if (!analysisId || !hotspotId) {
    return json({ error: "analysisId and hotspotId are required." }, 400);
  }
  const record = getRecord(analysisId) ?? await getSavedAnalysis(analysisId);
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
  log(`analysis=${analysisId} hotspot=${hotspotId} ("${hotspot.title}", ${hotspot.combinedTimeMs} ms): generating prompt`);

  let finalText = "";
  let usage: TokenUsage;
  try {
    ({ finalText, usage } = await runAgent({
      label: "hotspot-prompt",
      systemPrompt: FIX_PROMPT_SYSTEM_PROMPT,
      prompt: buildFixPromptUserPrompt(hotspot),
      cwd: record.dir || tmpdir(),
      maxOutputTokens: 2_048,
      builtinTools: [],
      timeoutMessage: "Debug prompt generation timed out. Please try again.",
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

  const prompt = finalText.trim()
    .replace(/^\s*```[a-z]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
  if (!prompt) {
    log("agent produced no prompt (final text empty)");
    return json(
      { error: "The agent finished without producing a prompt. Try again.", detail: finalText.slice(0, 400) || undefined },
      502
    );
  }

  record.prompts[hotspotId] = prompt;
  record.promptUsage[hotspotId] = usage;
  await updateSavedAnalysis(record);
  log(`prompt generated in ${Math.round((Date.now() - startedAt) / 1000)}s (${prompt.length} chars, ${usage.totalTokens} tokens)`);
  return json({ prompt, usage });
}

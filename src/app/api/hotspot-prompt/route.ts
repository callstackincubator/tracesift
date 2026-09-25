import { getRecord, getSavedAnalysis, updateSavedAnalysis, type TokenUsage } from "@/lib/analysis";
import { debugLog } from "@/lib/debug-log";
import { buildCpuFixPrompt } from "@/lib/prompts";

const LOG = "api/hotspot-prompt";
const ZERO_CPU_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };

function log(...parts: unknown[]): void {
  debugLog(LOG, ...parts);
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
  log(`analysis=${analysisId} hotspot=${hotspotId} ("${hotspot.title}", ${hotspot.combinedTimeMs} ms): rendering prompt`);
  const prompt = buildCpuFixPrompt(hotspot);
  const usage = { ...ZERO_CPU_USAGE };

  record.prompts[hotspotId] = prompt;
  record.promptUsage[hotspotId] = usage;
  await updateSavedAnalysis(record);
  log(`prompt rendered in ${Date.now() - startedAt}ms (${prompt.length} chars)`);
  return json({ prompt, usage });
}

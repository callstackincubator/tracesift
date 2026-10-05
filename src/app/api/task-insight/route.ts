/**
 * One task's inference, asked for from the card.
 *
 * It is not part of the upload. A reader opens an analysis to see what was
 * measured, and only some of the tasks on the page are worth a model's reading
 * — running every one of them up front spends a model call per card before
 * anyone has decided which card matters, and holds the upload open while it
 * does. So this is a button, and the cost is paid where it is chosen.
 *
 * The result is stored on the record, so a saved analysis keeps it and the card
 * does not pay twice for the same task.
 */

import { tmpdir } from "node:os";

import { getRecord, getSavedAnalysis, updateSavedAnalysis } from "@/lib/analysis";
import { getAnalysisSettings } from "@/lib/analysis";
import { inferTaskInsights } from "@/lib/task-insight";
import { debugLog } from "@/lib/debug-log";

const LOG = "api/task-insight";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: { analysisId?: unknown; cardId?: unknown } | null;
  try { body = (await request.json()) as typeof body; }
  catch { return json({ error: "Expected a JSON body with analysisId and cardId." }, 400); }

  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const cardId = typeof body?.cardId === "string" ? body.cardId : "";
  if (!analysisId || !cardId) return json({ error: "analysisId and cardId are required." }, 400);

  if (!(await getAnalysisSettings()).aiAssisted) {
    return json({ error: "AI assist is off. Turn it on in Analysis settings to have a model read this task." }, 409);
  }

  const record = getRecord(analysisId) ?? await getSavedAnalysis(analysisId);
  if (!record) {
    return json({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
  }
  const card = record.taskCards?.cards.find((entry) => entry.id === cardId);
  if (!card) return json({ error: "Unknown task id for this analysis." }, 404);
  if (card.insight) return json({ insight: card.insight, usage: record.usage });

  // The upload directory is gone once an analysis is saved, and this run opens
  // no files anyway — it is given no tools at all — so any readable directory
  // serves as the agent's cwd.
  const { insights, usage, model } = await inferTaskInsights([card], record.dir || tmpdir());
  const insight = insights.get(card.id);
  if (!insight) {
    debugLog(LOG, `analysis=${analysisId} ${cardId}: no usable inference`);
    return json({ error: "The model returned no usable reading of this task. Try again, or choose a different model in Analysis settings." }, 502);
  }

  card.insight = insight;
  // A hand-off rendered before the inference existed would otherwise be served
  // from the cache without it.
  delete record.prompts[cardId];
  delete record.promptUsage[cardId];
  record.usage = {
    input: record.usage.input + usage.input,
    output: record.usage.output + usage.output,
    cacheRead: record.usage.cacheRead + usage.cacheRead,
    cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
    totalTokens: record.usage.totalTokens + usage.totalTokens,
    costUsd: record.usage.costUsd + usage.costUsd,
  };
  record.model ??= model;
  await updateSavedAnalysis(record);
  debugLog(LOG, `analysis=${analysisId} ${cardId}: "${insight.title}" (${usage.totalTokens} tokens)`);
  return json({ insight, usage: record.usage, model: record.model });
}

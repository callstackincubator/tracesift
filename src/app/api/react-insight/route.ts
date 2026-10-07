/**
 * One React commit's inference, asked for from the card.
 *
 * The React twin of `/api/task-insight`, and it is a button for the same
 * reasons: only some of the cards on a page are worth a model's reading,
 * running every one up front spends a call per card before anyone has chosen,
 * and the result is stored on the record so a saved analysis keeps it and the
 * card does not pay twice.
 */

import { tmpdir } from "node:os";

import { findAnalysis, updateSavedAnalysis } from "@/lib/analysis";
import { inferReactCardInsight } from "@/lib/react-insight";
import { debugLog } from "@/lib/debug-log";

const LOG = "api/react-insight";

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

  const record = await findAnalysis(analysisId);
  if (!record) {
    return json({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
  }
  const card = record.reactCards?.cards.find((entry) => entry.id === cardId);
  if (!card) return json({ error: "Unknown commit id for this analysis." }, 404);
  if (card.insight) return json({ insight: card.insight, usage: record.usage });

  // This run opens no files — it is given no tools at all — and a React upload
  // is never kept on disk, so any readable directory serves as the agent's cwd.
  const { insight, usage, model } = await inferReactCardInsight(card, record.reactCards, record.dir || tmpdir());
  if (!insight) {
    debugLog(LOG, `analysis=${analysisId} ${cardId}: no usable inference`);
    return json({ error: "The model returned no usable reading of this commit. Try again, or choose a different model in Analysis settings." }, 502);
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

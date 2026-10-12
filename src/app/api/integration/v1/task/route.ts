/**
 * One task card, in full.
 *
 * `/analyze` deliberately ships cards without their `tree` and `timeline`: a
 * single task's untruncated call tree runs to several megabytes on a real
 * recording, and an analysis holds many of them. So the plugin takes the
 * summaries from `/analyze` and asks here for the one task a reader opened.
 */

import { findAnalysis } from "@/lib/analysis";
import { authorizeIntegrationRequest, INTEGRATION_API_VERSION } from "@/lib/integration-api";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeIntegrationRequest(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const analysisId = params.get("analysisId")?.trim() ?? "";
  const rawTaskIndex = params.get("taskIndex")?.trim() ?? "";
  const taskIndex = Number(rawTaskIndex);
  if (!analysisId || !rawTaskIndex || !Number.isInteger(taskIndex)) {
    return json({ error: "analysisId and an integer taskIndex are required." }, 400);
  }

  const record = await findAnalysis(analysisId);
  if (!record) return json({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
  const card = record.taskCards?.cards.find((entry) => entry.taskIndex === taskIndex);
  if (!card) return json({ error: "That task is not part of this analysis." }, 404);

  return json({ apiVersion: INTEGRATION_API_VERSION, analysisId, totalMs: record.totalMs, title: record.title, card });
}

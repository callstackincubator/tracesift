/**
 * One React analysis in full: every commit against the clock, and the tree
 * each one rendered.
 *
 * `/analyze` ships React cards as summaries, the same way it withholds a CPU
 * task's call tree until `/task` is asked for it. A commit timeline is larger
 * still — the whole strip for a real recording runs to several megabytes — so
 * it is never part of the analysis response and is served only to a reader that
 * opens the drill-down. The set is built once, when the profile is analyzed, so
 * the timeline, the cards, and this response cannot disagree about a commit.
 * Everything here is additive within API v1: new fields may arrive, existing
 * ones will not change meaning.
 */

import { findAnalysis } from "@/lib/analysis";
import { analysisNotFoundResponse, authorizeIntegrationRequest, integrationJson, INTEGRATION_API_VERSION } from "@/lib/integration-api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeIntegrationRequest(request);
  if (denied) return denied;

  const analysisId = new URL(request.url).searchParams.get("analysisId")?.trim() ?? "";
  if (!analysisId) return integrationJson({ error: "analysisId is required." }, 400);

  const record = await findAnalysis(analysisId);
  if (!record) return analysisNotFoundResponse();
  if (!record.reactExplore) {
    return integrationJson({
      error: "This analysis carries no commit timeline. It was produced before the drill-down existed, or by the React analyzer engine; re-run the profile to explore it.",
    }, 404);
  }

  return integrationJson({
    apiVersion: INTEGRATION_API_VERSION,
    analysisId,
    title: record.title,
    explore: record.reactExplore,
    cards: record.reactCards?.cards ?? [],
  });
}

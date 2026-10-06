/**
 * The React drill-down's data: every commit against the clock, and the tree
 * each one rendered.
 *
 * Fetched rather than handed over in storage, for the reason `/api/task-card`
 * exists: a hand-off through `sessionStorage` fails on exactly the recordings
 * worth opening, and fails silently. The whole set goes over in one response so
 * the strip is complete on arrival — clicking from one commit to the next is
 * then local, which is the whole point of a strip.
 */

import { getRecord, getSavedAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const id = params.get("a") ?? "";
  if (!id) return Response.json({ error: "An analysis id is required." }, { status: 400 });

  // The in-memory record first: an analysis is written to disk only when it was
  // saved, and Explore is normally opened on one that is still fresh.
  const record = getRecord(id) ?? (await getSavedAnalysis(id));
  if (!record?.reactExplore) {
    return Response.json({
      error: record
        ? "This analysis carries no commit timeline. It was produced before the drill-down existed, or by the React analyzer engine; re-run the profile to explore it."
        : "That analysis is no longer available.",
    }, { status: 404 });
  }

  return Response.json({
    analysisId: id,
    profileTitle: record.title,
    explore: record.reactExplore,
    cards: record.reactCards?.cards ?? [],
  });
}

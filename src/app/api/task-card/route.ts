/**
 * One task card, fetched by the drill-down tab.
 *
 * Explore used to be handed its task through `sessionStorage`, which cannot
 * carry one: a task card ships the task's whole call tree, deliberately
 * untruncated, and on a real recording that runs to several megabytes — past
 * the roughly five the browser allows an origin. The write threw, the throw was
 * swallowed so a click would never fail outright, and the tab opened empty.
 * Worse, it failed on exactly the longest tasks, which are the ones worth
 * opening. The analysis already lives on the server, so the tab asks for it.
 */

import { findAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const id = params.get("a") ?? "";
  const taskIndex = Number(params.get("task"));
  if (!id || !Number.isInteger(taskIndex)) {
    return Response.json({ error: "An analysis id and a task index are required." }, { status: 400 });
  }

  const record = await findAnalysis(id);
  const card = record?.taskCards?.cards.find((entry) => entry.taskIndex === taskIndex);
  if (!record || !card) {
    return Response.json({ error: "That task is not part of this analysis." }, { status: 404 });
  }

  return Response.json({ analysisId: id, totalMs: record.totalMs, profileTitle: record.title, card });
}

import { getRecord, getSavedAnalysis, updateSavedAnalysis } from "@/lib/analysis";
import { debugLog } from "@/lib/debug-log";
import { ZERO_REACT_USAGE } from "@/lib/react-analyzer";
import { buildReactFixPrompt } from "@/lib/prompts";
import { buildReactCardPrompt } from "@/lib/react-card-prompt";

export const runtime = "nodejs";

const LOG = "api/react-issue-prompt";

function log(...parts: unknown[]): void {
  debugLog(LOG, ...parts);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { analysisId?: unknown; issueId?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Expected a JSON body with analysisId and issueId." }, 400);
  }

  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const issueId = typeof body?.issueId === "string" ? body.issueId : "";

  if (!analysisId || !issueId) {
    return json({ error: "analysisId and issueId are required." }, 400);
  }
  const record = getRecord(analysisId) ?? await getSavedAnalysis(analysisId);
  if (!record) {
    return json({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
  }
  // Either engine's finding, keyed the same way: a measured card and a
  // model-selected issue both use `react-commit-<root>-<index>` as their id, so
  // a saved analysis from before the measured engine still renders a hand-off.
  const card = record.reactCards?.cards.find((entry) => entry.id === issueId);
  const issue = card ? undefined : record.reactIssues.find((entry) => entry.id === issueId);
  if (!card && !issue) {
    return json({ error: "Unknown issue id for this analysis." }, 404);
  }

  const cached = record.prompts[issueId];
  if (cached) {
    log(`analysis=${analysisId} issue=${issueId}: serving cached prompt (${cached.length} chars)`);
    return json({ prompt: cached, usage: record.promptUsage[issueId] });
  }
  log(`analysis=${analysisId} issue=${issueId} ("${card?.headline ?? issue?.summary}"): rendering prompt`);
  const prompt = card ? buildReactCardPrompt(card, record.reactCards) : buildReactFixPrompt(issue!);
  const usage = { ...ZERO_REACT_USAGE };

  record.prompts[issueId] = prompt;
  record.promptUsage[issueId] = usage;
  await updateSavedAnalysis(record);
  log(`prompt rendered in ${Date.now() - startedAt}ms (${prompt.length} chars)`);
  return json({ prompt, usage });
}

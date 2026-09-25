import { getRecord, getSavedAnalysis, updateSavedAnalysis } from "@/lib/analysis";
import { debugLog } from "@/lib/debug-log";
import { ZERO_REACT_USAGE } from "@/lib/react-analyzer";
import { buildReactFixPrompt } from "@/lib/prompts";

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
  const issue = record.reactIssues.find((entry) => entry.id === issueId);
  if (!issue) {
    return json({ error: "Unknown issue id for this analysis." }, 404);
  }

  const cached = record.prompts[issueId];
  if (cached) {
    log(`analysis=${analysisId} issue=${issueId}: serving cached prompt (${cached.length} chars)`);
    return json({ prompt: cached, usage: record.promptUsage[issueId] });
  }
  log(`analysis=${analysisId} issue=${issueId} ("${issue.summary}"): rendering prompt`);
  const prompt = buildReactFixPrompt(issue);
  const usage = { ...ZERO_REACT_USAGE };

  record.prompts[issueId] = prompt;
  record.promptUsage[issueId] = usage;
  await updateSavedAnalysis(record);
  log(`prompt rendered in ${Date.now() - startedAt}ms (${prompt.length} chars)`);
  return json({ prompt, usage });
}

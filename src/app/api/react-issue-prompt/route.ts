import { getRecord, type TokenUsage } from "@/lib/analysis";
import { AgentError, runAgent } from "@/lib/pi-agent";
import { buildReactFixPromptUserPrompt, REACT_FIX_PROMPT_SYSTEM_PROMPT } from "@/lib/prompts";
import { tmpdir } from "node:os";

export const runtime = "nodejs";

const LOG = "api/react-issue-prompt";

function log(...parts: unknown[]): void {
  console.log(`[perf-ai] ${new Date().toISOString()} [${LOG}]`, ...parts);
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
  const record = getRecord(analysisId);
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
  log(`analysis=${analysisId} issue=${issueId} ("${issue.summary}"): generating prompt`);

  let finalText = "";
  let usage: TokenUsage;
  try {
    ({ finalText, usage } = await runAgent({
      label: "react-issue-prompt",
      systemPrompt: REACT_FIX_PROMPT_SYSTEM_PROMPT,
      prompt: buildReactFixPromptUserPrompt(issue),
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
    console.error("[perf-ai] React issue prompt failed", error);
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

  record.prompts[issueId] = prompt;
  record.promptUsage[issueId] = usage;
  log(`prompt generated in ${Math.round((Date.now() - startedAt) / 1000)}s (${prompt.length} chars, ${usage.totalTokens} tokens)`);
  return json({ prompt, usage });
}

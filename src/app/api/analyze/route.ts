import { readFile } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAnalysisFiles,
  destroyRecord,
  MAX_UPLOAD_BYTES,
  normalizeHotspots,
  PROFILE_FILE_NAME,
  putRecord,
  type TokenUsage,
} from "@/lib/analysis";
import { summarizeCpuProfile } from "@/lib/js-profile";
import { MIN_HOTSPOT_TIME_MS } from "@/lib/bottlenecks";
import { AgentError, runAgent } from "@/lib/pi-agent";
import { ANALYST_SYSTEM_PROMPT, analystUserPrompt } from "@/lib/prompts";

const LOG = "api/analyze";

function log(...parts: unknown[]): void {
  console.log(`[perf-ai] ${new Date().toISOString()} [${LOG}]`, ...parts);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

const hotspotReportSchema = Type.Object({
  totalMs: Type.Optional(Type.Number({ description: "Total profile duration in milliseconds." })),
  hotspots: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String({ minLength: 1, maxLength: 120, description: "Describe the dominant expensive work, using the supporting functions." }),
      supportingFunctionIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: "IDs of supplied functions supporting the title and summary; include the heaviest function." }),
      summary: Type.String(),
      suggestedFix: Type.String(),
    }),
    { minItems: 1, maxItems: 12 }
  ),
});

/**
 * Fallback: some providers silently drop tool support and the model answers
 * with the report as plain text instead. Extract a { hotspots: [...] } JSON
 * object from the final text if the tool was never called.
 */
function extractReportFromText(text: string): { totalMs?: number; hotspots?: unknown[] } | null {
  if (!text || !text.includes("hotspots")) return null;
  const start = text.indexOf("{");
  for (let i = start; i >= 0; i = text.indexOf("{", i + 1)) {
    if (i < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
            if (Array.isArray(parsed.hotspots)) {
              return {
                totalMs: typeof parsed.totalMs === "number" ? parsed.totalMs : undefined,
                hotspots: parsed.hotspots,
              };
            }
          } catch {
            // Not valid JSON — keep scanning.
          }
          break;
        }
      }
    }
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let form: FormData | null;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected a multipart form containing the profile file." }, 400);
  }

  const profile = form.get("profile");
  if (!(profile instanceof File) || profile.size === 0) {
    log("rejected: no profile file in request");
    return json({ error: "A CPU profile file is required." }, 400);
  }
  if (profile.size > MAX_UPLOAD_BYTES) {
    log(`rejected: profile too large (${profile.size} bytes)`);
    return json({ error: "The profile file is too large (max 25 MB)." }, 413);
  }

  log(`request received: profile="${profile.name}" (${profile.size} bytes)`);

  let created;
  try {
    created = await createAnalysisFiles(profile);
  } catch (error) {
    log("failed to store upload:", error instanceof Error ? error.message : error);
    return json({ error: "Could not store the uploaded profile on the server." }, 500);
  }
  const { id, dir } = created;
  log(`analysis ${id} stored in ${dir}`);

  let summary;
  let queriedHotspots;
  let bottlenecks;
  try {
    const rawProfile = JSON.parse(await readFile(`${dir}/${PROFILE_FILE_NAME}`, "utf8")) as unknown;
    ({ summary, hotspots: queriedHotspots, bottlenecks } = summarizeCpuProfile(rawProfile, id, profile.name));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`failed to parse profile: ${reason}`);
    await destroyRecord(id, dir);
    return json(
      {
        error: "The uploaded file could not be parsed as a CPU profile.",
        detail: reason,
      },
      400
    );
  }
  const totalMs = summary.session.durationMs;
  const top = queriedHotspots.items[0];
  log(
    `profile summary: total=${Math.round(totalMs)} ms, samples=${summary.session.sampleCount}, hotspots=${queriedHotspots.total}, topSelf=${top ? `${top.functionName} (${top.selfTimeMs} ms)` : "n/a"}`
  );

  if (bottlenecks.length === 0) {
    log(`no hotspots reached ${MIN_HOTSPOT_TIME_MS} ms — skipping analyzer`);
    await destroyRecord(id, dir);
    return json({ error: `No hotspots of at least ${MIN_HOTSPOT_TIME_MS} ms were found in this profile.` }, 422);
  }

  const capture: { report?: unknown } = {};
  const reportTool: ToolDefinition = defineTool({
    name: "report_hotspots",
    label: "Report hotspots",
    description:
      "Submit the final ranked list of CPU profile hotspots. Call exactly once with the complete report, using the provided group IDs. The root block must not be included.",
    parameters: hotspotReportSchema,
    execute: async (_toolCallId, params) => {
      capture.report = params;
      log(`report_hotspots called: ${Array.isArray((params as { hotspots?: unknown[] }).hotspots) ? (params as { hotspots: unknown[] }).hotspots.length : 0} hotspots`);
      return {
        content: [
          {
            type: "text",
            text: "Hotspot report received. Task complete — reply with a one-line confirmation and stop.",
          },
        ],
        details: { received: true },
      };
    },
  });

  let finalText: string;
  let usage: TokenUsage;

  const analystPrompt = analystUserPrompt(bottlenecks, totalMs);
  log(`analyst prompt: ${analystPrompt}`);

  try {
    ({ finalText, usage } = await runAgent({
      label: "analyze",
      systemPrompt: ANALYST_SYSTEM_PROMPT,
      prompt: analystPrompt,
      cwd: dir,
      customTools: [reportTool],
      builtinTools: [],
      timeoutMs: 480_000,
    }));
  } catch (error) {
    log(`agent run failed: ${error instanceof Error ? error.message : error}`);
    await destroyRecord(id, dir);
    if (error instanceof AgentError) {
      return json({ error: error.message }, error.status);
    }
    console.error("[perf-ai] analyze failed", error);
    return json({ error: "Unexpected server error while running the analysis agent." }, 500);
  }

  let report = capture.report as { totalMs?: unknown; hotspots?: unknown } | undefined;
  if (!report || typeof report !== "object" || !Array.isArray(report.hotspots)) {
    log("agent did not call report_hotspots — trying to extract the report from the final text");
    const fallback = extractReportFromText(finalText);
    if (fallback && Array.isArray(fallback.hotspots) && fallback.hotspots.length > 0) {
      report = fallback;
      log(`fallback extraction succeeded: ${fallback.hotspots.length} hotspots`);
    }
  }

  if (!report || typeof report !== "object" || !Array.isArray(report.hotspots)) {
    log("no report found in tool call or final text — giving up");
    await destroyRecord(id, dir);
    return json(
      {
        error: "The agent finished without submitting a hotspot report. Try again.",
        detail: finalText.slice(0, 400) || undefined,
      },
      502
    );
  }

  const { hotspots } = normalizeHotspots(report.hotspots, totalMs, bottlenecks);
  if (hotspots.length === 0) {
    log("report had no usable hotspots after normalization");
    await destroyRecord(id, dir);
    return json({ error: "No meaningful hotspots were found in this profile." }, 502);
  }

  putRecord({
    id,
    createdAt: Date.now(),
    dir,
    totalMs,
    hotspots,
    prompts: {},
    usage,
    promptUsage: {},
  });

  log(`analysis ${id} complete in ${Math.round((Date.now() - startedAt) / 1000)}s — ${hotspots.length} hotspots (analyzer tokens: ${usage.totalTokens}) — ` + hotspots.map((h) => `${h.title} (${h.combinedTimeMs} ms)`).join(" | "));
  return json({ analysisId: id, totalMs, hotspots, usage });
}

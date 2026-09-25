import { readFile } from "node:fs/promises";
import {
  clientHotspots,
  createAnalysisFiles,
  destroyRecord,
  MAX_UPLOAD_BYTES,
  PROFILE_FILE_NAME,
  putRecord,
  getAnalysisSettings,
  saveAnalysis,
  type AnalysisModel,
  type Hotspot,
  type TokenUsage,
} from "@/lib/analysis";
import { summarizeCpuProfile } from "@/lib/js-profile";
import { MIN_HOTSPOT_TIME_MS } from "@/lib/bottlenecks";
import { CpuAnalysisError, analyzeCpuBottlenecks } from "@/lib/cpu-analyzer";
import { AgentError } from "@/lib/pi-agent";
import { analysisPromptData } from "@/lib/prompt-data";
import { debugLog } from "@/lib/debug-log";

const LOG = "api/analyze";

function log(...parts: unknown[]): void {
  debugLog(LOG, ...parts);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
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
    log(`no actionable hotspots reached ${MIN_HOTSPOT_TIME_MS} ms — skipping analyzer`);
    await destroyRecord(id, dir);
    return json({ error: `No actionable hotspots of at least ${MIN_HOTSPOT_TIME_MS} ms were found in this profile. Work spent entirely inside React and scheduler internals is excluded.` }, 422);
  }

  let hotspots: Hotspot[];
  let usage: TokenUsage;
  let model: AnalysisModel | undefined;

  const suppliedGroups = analysisPromptData(bottlenecks);
  const inputBreakdown = {
    profile: {
      totalDurationMs: totalMs,
      sampleCount: summary.session.sampleCount,
      extractedHotspotCount: queriedHotspots.total,
      actionableBottleneckCount: bottlenecks.length,
    },
    selection: {
      suppliedGroupCount: suppliedGroups.length,
      omittedGroupCount: Math.max(0, bottlenecks.length - suppliedGroups.length),
      maximumGroups: 12,
    },
    groups: suppliedGroups.map((group) => {
      const source = bottlenecks.find((candidate) => candidate.id === group.id);
      return {
        id: group.id,
        groupingCaller: group.groupingCaller,
        combinedTimeMs: group.combinedTimeMs,
        percentOfTotal: group.percentOfTotal,
        sourceFunctionCount: source?.functions.length ?? group.functions.length + group.omittedFunctionCount,
        suppliedFunctionCount: group.functions.length,
        omittedFunctionCount: group.omittedFunctionCount,
        otherSelfTimeMs: group.otherSelfTimeMs,
        groupStackFramesSupplied: group.stack.length,
        functions: group.functions.map((fn) => ({
          id: fn.id,
          title: fn.title,
          selfTimeMs: fn.selfTimeMs,
          percentOfGroup: fn.percentOfGroup,
          sourceLocation: fn.sourceLocation,
          stackFramesSupplied: fn.stack.length,
        })),
        serializedBytes: Buffer.byteLength(JSON.stringify(group), "utf8"),
      };
    }),
  };

  try {
    ({ hotspots, usage, model } = await analyzeCpuBottlenecks(bottlenecks, totalMs, dir, inputBreakdown));
  } catch (error) {
    log(`agent run failed: ${error instanceof Error ? error.message : error}`);
    await destroyRecord(id, dir);
    if (error instanceof AgentError || error instanceof CpuAnalysisError) {
      return json({ error: error.message }, error.status);
    }
    console.error("[tracesift] analyze failed", error);
    return json({ error: "Unexpected server error while running the analysis agent." }, 500);
  }

  const record = {
    id,
    createdAt: Date.now(),
    dir,
    totalMs,
    hotspots,
    reactIssues: [],
    prompts: {},
    usage,
    model,
    promptUsage: {},
    profileType: "cpu" as const,
    title: profile.name,
    saved: false,
  };
  putRecord(record);
  const settings = await getAnalysisSettings();
  let saved = false;
  if (settings.autoSave) {
    try { await saveAnalysis(record); saved = true; }
    catch (error) { log("could not auto-save analysis:", error instanceof Error ? error.message : error); }
  }

  log(`analysis ${id} complete in ${Math.round((Date.now() - startedAt) / 1000)}s — ${hotspots.length} hotspots (analyzer tokens: ${usage.totalTokens}) — ` + hotspots.map((h) => `${h.title} (${h.combinedTimeMs} ms)`).join(" | "));
  const response = { analysisId: id, profileType: "cpu", title: profile.name, saved, totalMs, hotspots: clientHotspots(hotspots), usage, model };
  log("SANITIZED_ANALYSIS_RESULT", JSON.stringify(response));
  return json(response);
}

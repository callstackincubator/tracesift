import { readFile } from "node:fs/promises";
import {
  clientCards,
  clientHotspots,
  createAnalysisFiles,
  destroyRecord,
  maxUploadBytes,
  PROFILE_FILE_NAME,
  uploadTooLargeMessage,
  putRecord,
  getAnalysisSettings,
  saveAnalysis,
} from "@/lib/analysis";
import { summarizeCpuProfile } from "@/lib/js-profile";
import { CpuAnalysisError } from "@/lib/cpu-analyzer";
import { legacyEngineRequested, nodeCardEngineRequested, runLegacyCpuAnalysis } from "@/lib/legacy-cpu-analysis";
import { classifyFrames, ruleClassTable } from "@/lib/frame-classes";
import { selectTaskCards } from "@/lib/task-cards";
import { AgentError } from "@/lib/pi-agent";
import { debugLog } from "@/lib/debug-log";
import type { AnalysisModel, Hotspot, TokenUsage } from "@/lib/analysis";

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
  if (profile.size > maxUploadBytes()) {
    log(`rejected: profile too large (${profile.size} bytes)`);
    return json({ error: uploadTooLargeMessage() }, 413);
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
  let cards;
  let parsedProfile;
  let tasks;
  let legacyBottlenecks;
  try {
    const rawProfile = JSON.parse(await readFile(`${dir}/${PROFILE_FILE_NAME}`, "utf8")) as unknown;
    ({ summary, hotspots: queriedHotspots, cards, profile: parsedProfile, tasks, legacyBottlenecks } =
      summarizeCpuProfile(rawProfile, id, profile.name));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`failed to parse profile: ${reason}`);
    await destroyRecord(id, dir);
    return json({ error: "The uploaded file could not be parsed as a CPU profile.", detail: reason }, 400);
  }
  const totalMs = summary.session.durationMs;
  const top = queriedHotspots.items[0];
  log(
    `profile summary: total=${Math.round(totalMs)} ms, samples=${summary.session.sampleCount}, hotspots=${queriedHotspots.total}, topSelf=${top ? `${top.functionName} (${top.selfTimeMs} ms)` : "n/a"}`
  );

  // One classification pass over the distinct frames of the upload, cached by
  // name and url. Everything a task card says about which code is whose is a
  // lookup in this table, so the same file always produces the same cards.
  const classes = nodeCardEngineRequested() ? ruleClassTable() : await classifyFrames(
    parsedProfile.nodes.map((node) => node.callFrame), dir,
  );
  const taskCards = nodeCardEngineRequested()
    ? undefined
    : selectTaskCards(parsedProfile, totalMs, tasks, classes);
  if (taskCards) {
    log(
      `tasks: ${tasks.tasks.length} (${tasks.boundaries}) — ${taskCards.cards.length} cards` +
      `${taskCards.noLongTasks ? ", none over the long-task floor" : ""}` +
      `${classes.degraded ? ", frame classes degraded to rules" : ""}`
    );
  }

  // `TRACESIFT_CPU_ENGINE=legacy` runs the engine cards replace, so a suspicious
  // profile can be checked against it.
  let legacyHotspots: Hotspot[] = [];
  let usage: TokenUsage = classes.usage;
  let model: AnalysisModel | undefined = classes.model;
  if (legacyEngineRequested()) {
    const groups = legacyBottlenecks();
    log(`TRACESIFT_CPU_ENGINE=legacy — running the previous engine over ${groups.length} groups`);
    try {
      ({ hotspots: legacyHotspots, usage, model } = await runLegacyCpuAnalysis(
        groups, totalMs, dir, summary.session.sampleCount, queriedHotspots.total,
      ));
    } catch (error) {
      log(`legacy engine failed: ${error instanceof Error ? error.message : error}`);
      await destroyRecord(id, dir);
      if (error instanceof AgentError || error instanceof CpuAnalysisError) {
        return json({ error: error.message }, error.status);
      }
      return json({ error: "Unexpected server error while running the legacy analysis engine." }, 500);
    }
    log(`legacy engine titles: ${legacyHotspots.map((entry) => `${entry.title} (${entry.combinedTimeMs} ms)`).join(" | ")}`);
  }

  if ((taskCards?.cards.length ?? 0) === 0 && cards.cards.length === 0 && legacyHotspots.length === 0) {
    log("no task and no subtree carried measurable work — nothing to report");
    await destroyRecord(id, dir);
    return json({ error: "No measured work was found in this profile. Time spent entirely idle, or in frames the profiler could not name, is excluded." }, 422);
  }

  const record = {
    id,
    createdAt: Date.now(),
    dir,
    totalMs,
    hotspots: legacyHotspots,
    taskCards,
    cards: cards.cards,
    callCountIsExact: cards.callCountIsExact,
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

  const headlines = taskCards
    ? taskCards.cards.map((card) => `${card.headline} [${card.boundaryFrames.map((entry) => entry.name).join(", ")}]`)
    : cards.cards.map((card) => `${card.title} (${card.totalMs} ms)`);
  log(`analysis ${id} complete in ${Date.now() - startedAt}ms — ${headlines.length} cards — ` + headlines.join(" | "));
  const response = {
    analysisId: id,
    profileType: "cpu",
    title: profile.name,
    saved,
    totalMs,
    taskCards,
    cards: clientCards(cards.cards),
    callCountIsExact: cards.callCountIsExact,
    hotspots: clientHotspots(legacyHotspots),
    usage,
    model,
  };
  log("SANITIZED_ANALYSIS_RESULT", JSON.stringify(response));
  return json(response);
}

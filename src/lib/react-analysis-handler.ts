import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_UPLOAD_BYTES, putRecord, getAnalysisSettings, saveAnalysis } from "./analysis.ts";
import { parseReactProfileOptions, ReactProfileError } from "./react-profile.ts";
import type { extractReactProfile } from "./react-profile.ts";
import { requireReactEvidence, withinReactBudget, noReactIssues, ZERO_REACT_USAGE, discardSubBudgetReactIssues, type analyzeReactProfile } from "./react-analyzer.ts";
import { parseFrameBudget } from "./react-evidence.ts";

interface Dependencies {
  extract: typeof extractReactProfile;
  analyze: (result: Awaited<ReturnType<typeof extractReactProfile>>, cwd: string, budget: number) => ReturnType<typeof analyzeReactProfile>;
  temporaryRoot?: string;
}

/** Dependencies keep HTTP/error/cleanup tests independent of a live model. */
export function createReactAnalysisHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    let dir: string | undefined;
    try {
      let form: FormData;
      try { form = await request.formData(); }
      catch { throw new ReactProfileError(400, "Expected a multipart form containing the profile file."); }
      const profile = form.get("profile");
      if (!(profile instanceof File) || !profile.size) throw new ReactProfileError(400, "A React profile file is required.");
      if (profile.size > MAX_UPLOAD_BYTES) throw new ReactProfileError(413, "The profile file is too large (max 25 MB).");
      const options = parseReactProfileOptions(form);
      const frameBudgetMs = parseFrameBudget(form);
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
      dir = await mkdtemp(path.join(dependencies.temporaryRoot ?? tmpdir(), "perf-ai-react-"));
      const file = path.join(dir, "profile.json");
      await writeFile(file, Buffer.from(await profile.arrayBuffer()));
      const result = await dependencies.extract(file, options, request.signal, { analysisEvidence: true, maxBuffer: 8 * 1024 * 1024 });
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
      const evidence = requireReactEvidence(result);
      const analysis = withinReactBudget(evidence, frameBudgetMs)
        ? { ...noReactIssues(), usage: { ...ZERO_REACT_USAGE } }
        : await dependencies.analyze(result, dir, frameBudgetMs);
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
      const report = discardSubBudgetReactIssues(analysis, evidence, frameBudgetMs);
      const analysisId = randomUUID();
      const record = {
          id: analysisId,
          createdAt: Date.now(),
          dir: "",
          totalMs: evidence.summary.totalCommitRenderDurationMs,
          hotspots: [],
          reactIssues: report.issues,
          prompts: {},
          usage: analysis.usage,
          promptUsage: {},
          profileType: "react" as const,
          title: profile.name,
          saved: false,
      };
      putRecord(record);
      const settings = await getAnalysisSettings();
      let saved = false;
      if (settings.autoSave) {
        try { await saveAnalysis(record); saved = true; }
        catch (error) { console.warn("[perf-ai] could not auto-save analysis:", error); }
      }
      const response = { profileType: "react", title: profile.name, saved, analysisId, summary: { ...evidence.summary,
        commitsOverBudget: evidence.commitDurations.filter(ms => ms > frameBudgetMs).length,
        omittedEvidenceCommitCount: evidence.omittedCommitCount,
      }, ...report, frameBudgetMs, usage: analysis.usage };
      console.log("[perf-ai] SANITIZED_ANALYSIS_RESULT", JSON.stringify(response));
      return Response.json(response);
    } catch (error) {
      if (error instanceof ReactProfileError || (error instanceof Error && "status" in error && typeof error.status === "number"
          && error.status >= 400 && error.status <= 599)) {
        return Response.json({ error: error.message }, { status: error.status as number });
      }
      console.error("[perf-ai] React analysis failed", error);
      return Response.json({ error: "Unexpected server error while analyzing the React profile." }, { status: 500 });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

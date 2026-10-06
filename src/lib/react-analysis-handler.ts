import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { maxUploadBytes, uploadTooLargeMessage, putRecord, getAnalysisSettings, saveAnalysis } from "./analysis.ts";
import { parseReactProfileOptions, ReactProfileError } from "./react-profile.ts";
import type { extractReactProfile } from "./react-profile.ts";
import { requireReactEvidence, withinReactBudget, noReactIssues, ZERO_REACT_USAGE, discardSubBudgetReactIssues, type analyzeReactProfile } from "./react-analyzer.ts";
import { parseFrameBudget } from "./react-evidence.ts";
import { parseReactExport, ReactCommitTreeError } from "./react-commit-tree.ts";
import { buildReactCards, type ReactCardSet } from "./react-cards.ts";
import { buildReactExplore } from "./react-explore.ts";
import { debugLog } from "./debug-log.ts";

/**
 * Either engine, chosen by what the caller supplies.
 *
 * `parse` is the measured path: the export is read in this process and the
 * cards are arithmetic over it, so no model runs, no child process starts and
 * nothing needs a working directory. `extract` and `analyze` are the model
 * path, which the production route now wires only under
 * `TRACESIFT_REACT_ENGINE=analyzer` — the same escape hatch
 * `TRACESIFT_CPU_ENGINE` leaves open on the CPU side, so a suspicious profile
 * can still be run through both and compared.
 */
interface Dependencies {
  parse?: typeof parseReactExport;
  extract?: typeof extractReactProfile;
  analyze?: (result: Awaited<ReturnType<typeof extractReactProfile>>, cwd: string, budget: number) => ReturnType<typeof analyzeReactProfile>;
  temporaryRoot?: string;
}

/** The profiler re-parses the whole profile, so the budget has to grow with it. */
function extractionTimeoutMs(bytes: number): number {
  const perMegabyteMs = 1_000;
  return Math.min(600_000, 30_000 + Math.ceil(bytes / (1024 * 1024)) * perMegabyteMs);
}

/**
 * The header line's figures, in the shape the results page already reads.
 *
 * Kept identical to the model path's summary so one view serves records from
 * either engine, including saved ones.
 */
function cardSetSummary(set: ReactCardSet) {
  return {
    rootCount: set.roots.length,
    commitCount: set.commitCount,
    totalCommitRenderDurationMs: set.totalRenderMs,
    peakCommitDurationMs: set.peakCommitMs,
    commitsOverBudget: set.commitsOverBudget,
    // Nothing is omitted from a measured pass. The field stays so the view does
    // not have to know which engine produced the record it is rendering.
    omittedEvidenceCommitCount: 0,
  };
}

/** Dependencies keep HTTP/error/cleanup tests independent of a live model. */
export function createReactAnalysisHandler(dependencies: Dependencies) {
  const modelEngine = Boolean(dependencies.extract && dependencies.analyze);
  return async function POST(request: Request): Promise<Response> {
    let dir: string | undefined;
    try {
      let form: FormData;
      try { form = await request.formData(); }
      catch { throw new ReactProfileError(400, "Expected a multipart form containing the profile file."); }
      const profile = form.get("profile");
      if (!(profile instanceof File) || !profile.size) throw new ReactProfileError(400, "A React profile file is required.");
      // Only the model path needs a provider. The measured path is arithmetic
      // over the export, so React profiles now analyze with AI assist off —
      // which is what the upload pane's React option used to be disabled for.
      if (modelEngine && !(await getAnalysisSettings()).aiAssisted) {
        throw new ReactProfileError(409, "The React analyzer engine needs AI assist. Turn it on in Analysis settings, or unset TRACESIFT_REACT_ENGINE to use the measured engine.");
      }
      if (profile.size > maxUploadBytes()) throw new ReactProfileError(413, uploadTooLargeMessage());
      const options = parseReactProfileOptions(form);
      const frameBudgetMs = parseFrameBudget(form);
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");

      const settings = await getAnalysisSettings();
      const base = { createdAt: Date.now(), prompts: {}, promptUsage: {}, profileType: "react" as const, title: profile.name, saved: false, hotspots: [] };

      if (!modelEngine) {
        const parse = dependencies.parse ?? parseReactExport;
        let raw: unknown;
        try { raw = JSON.parse(await profile.text()); }
        catch { throw new ReactProfileError(400, "The uploaded file could not be parsed as JSON."); }
        if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
        let set: ReactCardSet;
        let explore;
        try {
          const recordings = parse(raw);
          set = buildReactCards(recordings, frameBudgetMs);
          // Built from the same parse, so the strip and the cards cannot
          // disagree about a commit's duration or its place on the clock.
          explore = buildReactExplore(recordings, set);
        }
        catch (error) {
          if (error instanceof ReactCommitTreeError) throw new ReactProfileError(400, error.message);
          throw error;
        }
        if (set.commitCount === 0) {
          throw new ReactProfileError(422, "The selected recording contains no React commits. Record a React interaction before analyzing.");
        }
        if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
        const analysisId = randomUUID();
        const record = {
          ...base, id: analysisId, dir: "", totalMs: set.totalRenderMs,
          reactIssues: [], reactCards: set, reactExplore: explore, usage: { ...ZERO_REACT_USAGE },
        };
        putRecord(record);
        let saved = false;
        if (settings.autoSave) {
          try { await saveAnalysis(record); saved = true; }
          catch (error) { console.warn("[tracesift] could not auto-save analysis:", error); }
        }
        const response = {
          profileType: "react", title: profile.name, saved, analysisId,
          summary: cardSetSummary(set), reactCards: set, frameBudgetMs,
          // Named for the view, which renders a record from either engine.
          issues: [], noIssue: set.cards.length === 0,
          usage: { ...ZERO_REACT_USAGE },
        };
        debugLog("api/analyze/react", "MEASURED_ANALYSIS_RESULT", `${set.cards.length} cards, ${set.commitsOverBudget}/${set.commitCount} commits over ${frameBudgetMs} ms`);
        return Response.json(response);
      }

      dir = await mkdtemp(path.join(dependencies.temporaryRoot ?? tmpdir(), "tracesift-react-"));
      const file = path.join(dir, "profile.json");
      await writeFile(file, Buffer.from(await profile.arrayBuffer()));
      const result = await dependencies.extract!(file, options, request.signal, {
        analysisEvidence: true,
        // Evidence is a reduction of the profile, so the upload size is a generous
        // upper bound; both scale with the input so large profiles are not cut off.
        maxBuffer: Math.max(8 * 1024 * 1024, profile.size),
        timeoutMs: extractionTimeoutMs(profile.size),
      });
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
      const evidence = requireReactEvidence(result);
      const analysis = withinReactBudget(evidence, frameBudgetMs)
        ? { ...noReactIssues(), usage: { ...ZERO_REACT_USAGE } }
        : await dependencies.analyze!(result, dir, frameBudgetMs);
      if (request.signal.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
      const report = discardSubBudgetReactIssues(analysis, evidence, frameBudgetMs);
      const analysisId = randomUUID();
      const record = {
          ...base,
          id: analysisId,
          dir: "",
          totalMs: evidence.summary.totalCommitRenderDurationMs,
          reactIssues: report.issues,
          usage: analysis.usage,
          model: analysis.model,
      };
      putRecord(record);
      let saved = false;
      if (settings.autoSave) {
        try { await saveAnalysis(record); saved = true; }
        catch (error) { console.warn("[tracesift] could not auto-save analysis:", error); }
      }
      const response = { profileType: "react", title: profile.name, saved, analysisId, summary: { ...evidence.summary,
        commitsOverBudget: evidence.commitDurations.filter(ms => ms > frameBudgetMs).length,
        omittedEvidenceCommitCount: evidence.omittedCommitCount,
      }, ...report, frameBudgetMs, usage: analysis.usage, model: analysis.model };
      debugLog("api/analyze/react", "SANITIZED_ANALYSIS_RESULT", JSON.stringify(response));
      return Response.json(response);
    } catch (error) {
      if (error instanceof ReactProfileError || (error instanceof Error && "status" in error && typeof error.status === "number"
          && error.status >= 400 && error.status <= 599)) {
        return Response.json({ error: error.message }, { status: error.status as number });
      }
      console.error("[tracesift] React analysis failed", error);
      return Response.json({ error: "Unexpected server error while analyzing the React profile." }, { status: 500 });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

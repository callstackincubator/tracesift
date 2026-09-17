import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TokenUsage } from "./analysis";
import type { RunAgentOptions, RunAgentResult } from "./pi-agent";
import { ReactProfileError, type ReactProfileResult } from "./react-profile.ts";
import type { ReactCommitEvidence, ReactEvidence } from "./react-evidence.ts";
import { REACT_ANALYST_SYSTEM_PROMPT } from "./prompts.ts";

export interface ReactIssue {
  id: string;
  summary: string;
  severity: "low" | "medium" | "high";
  evidence: string;
  componentId: string;
  component: string;
  commits: Pick<ReactCommitEvidence, "rootID" | "commitIndex" | "timestampMs" | "durationMs">[];
  selfTimeMs?: number;
  percentOfCommit?: number;
}
export interface ReactAnalysis {
  issues: ReactIssue[];
  noIssue: boolean;
  reasoning?: string;
}
export const ZERO_REACT_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };

export function requireReactEvidence(result: ReactProfileResult): ReactEvidence {
  if (!result.evidence) throw new ReactProfileError(502, "The React profiler did not return analysis evidence.");
  if (!result.evidence.summary.commitCount) throw new ReactProfileError(422, "The selected recording contains no React commits. Record a React interaction before analyzing.");
  return result.evidence;
}

export function withinReactBudget(evidence: ReactEvidence, budget: number): boolean {
  return evidence.summary.peakCommitDurationMs !== null && evidence.summary.peakCommitDurationMs <= budget;
}
export function noReactIssues(): ReactAnalysis {
  return { issues: [], noIssue: true };
}
export function discardSubBudgetReactIssues(report: ReactAnalysis, evidence: ReactEvidence, budget: number): ReactAnalysis {
  if (withinReactBudget(evidence, budget) || report.issues.length === 0) return noReactIssues();
  return report;
}

function promptEvidence(result: ReactProfileResult, budget: number) {
  const evidence = requireReactEvidence(result);
  // The complete duration list is used only by the server, never sent to the model.
  const { commitDurations, ...bounded } = structuredClone(evidence);
  const payload = { ...bounded, thresholds: { commitDurationMs: budget },
    commitsOverBudget: commitDurations.filter(ms => ms > budget).length,
    textTruncated: false,
  };
  // Sub-budget commits can't back an issue anyway (validateReactIssueReport rejects
  // them); drop them from the supplied set and count them as omitted like the rest.
  {
    const kept = payload.commits.filter(commit => commit.durationMs > budget);
    payload.omittedCommitCount += payload.commits.length - kept.length;
    payload.commits = kept;
  }
  // elementType, key, and metadataMissing are DevTools bookkeeping the analyst
  // never reasons about; drop them from the aggregate views before sending.
  for (const rows of [payload.slowestComponentsByAverageDuration, payload.componentsByRenderCount, payload.componentsByTotalSelfDuration]) {
    for (const component of rows) {
      delete (component as Partial<typeof component>).elementType;
      delete (component as Partial<typeof component>).key;
      delete (component as Partial<typeof component>).metadataMissing;
    }
  }
  // Names and change lists are already capped by the extractor. Bound unusually verbose
  // recordings further without dropping commit identities or their exact timings.
  if (JSON.stringify(payload).length > 200_000) {
    payload.textTruncated = true;
    for (const commit of payload.commits) {
      for (const component of commit.components) {
        component.changedProps = component.changedProps.slice(0, 3).map(v => v.slice(0, 40));
        component.changedHooks = component.changedHooks.slice(0, 3).map(v => v.slice(0, 40));
      }
    }
    for (const rows of [payload.slowestComponentsByAverageDuration, payload.componentsByRenderCount, payload.componentsByTotalSelfDuration]) {
      for (const component of rows) {
        component.changedProps = component.changedProps.slice(0, 3).map(v => v.slice(0, 40));
        component.changedHooks = component.changedHooks.slice(0, 3).map(v => v.slice(0, 40));
      }
    }
    for (const commit of payload.commits) {
      const kept = commit.updaters.slice(0, 3);
      commit.omittedUpdaterCount += commit.updaters.length - kept.length;
      commit.updaters = kept;
    }
    // Keep every selected commit and all three aggregate views. If text is still
    // large, shed the lowest-self-time rows evenly and account for each omission.
    while (JSON.stringify(payload).length > 200_000) {
      let removed = false;
      for (const commit of payload.commits) {
        if (commit.components.length > 1) {
          commit.components.pop();
          commit.omittedComponentCount++;
          removed = true;
        }
      }
      if (!removed) break;
    }
  }
  return payload;
}
export function reactAnalystPrompt(result: ReactProfileResult, budget = 16): string {
  return JSON.stringify(promptEvidence(result, budget));
}

const MAX_ISSUE_TITLE = 120;
const MAX_EVIDENCE_LINE = 180;
const MAX_EVIDENCE_LINES = 2;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 2000;
function clipLine(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
function normalizeIssueTitle(value: string) {
  return clipLine(value.trim().split(/\n+/)[0]?.trim() ?? "", MAX_ISSUE_TITLE);
}
function normalizeIssueEvidence(value: string) {
  const trimmed = value.trim();
  const lines = trimmed.split(/\n+/).map(line => line.replace(/^[-*•\d.)]+\s+/, "").trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : trimmed.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
  return parts.slice(0, MAX_EVIDENCE_LINES).map(line => clipLine(line, MAX_EVIDENCE_LINE)).join("\n");
}

/** Model text can select findings, but cannot replace measured identities or timings. */
export function validateReactIssueReport(raw: unknown, evidence: ReactEvidence, budget: number): ReactAnalysis {
  const fail = (): never => { throw new ReactProfileError(502, "The analyzer returned an invalid React issue report."); };
  if (!object(raw) || !Array.isArray(raw.issues) || raw.issues.length > 12 || typeof raw.noIssue !== "boolean"
    || raw.noIssue !== (raw.issues.length === 0) || (raw.issues.length > 0 && !text(raw.reasoning))) return fail();
  const commitsByID = new Map(evidence.commits.map(commit => [`${commit.rootID}:${commit.commitIndex}`, commit]));
  const seen = new Set<string>();
  const issues = raw.issues.flatMap((item, index): ReactIssue[] => {
    if (!object(item) || !text(item.summary) || !text(item.evidence)
      || !["low", "medium", "high"].includes(item.severity as string)
      || (item.componentId !== undefined && typeof item.componentId !== "string")
      || !Array.isArray(item.commits) || !item.commits.length || item.commits.length > 50) return fail();
    const references = new Set();
    let componentName: string | undefined;
    let selfTimeMs: number | undefined;
    let selfTimeCommitDurationMs: number | undefined;
    const commits = item.commits.map(ref => {
      if (!object(ref) || !Number.isSafeInteger(ref.rootID) || !Number.isSafeInteger(ref.commitIndex)) return fail();
      const key = `${ref.rootID}:${ref.commitIndex}`;
      const commit = commitsByID.get(key);
      if (!commit || references.has(key) || commit.durationMs <= budget) return fail();
      references.add(key);
      if (item.componentId !== undefined) {
        const component = commit.components.find(c => c.id === item.componentId);
        if (!component || component.fiberID === commit.rootID) return fail();
        componentName = component.displayName;
        if (component.selfDurationMs !== null && (selfTimeMs === undefined || component.selfDurationMs > selfTimeMs)) {
          selfTimeMs = component.selfDurationMs;
          selfTimeCommitDurationMs = commit.durationMs;
        }
      }
      return { rootID: commit.rootID, commitIndex: commit.commitIndex, timestampMs: commit.timestampMs, durationMs: commit.durationMs };
    });
    // Older model responses may still report an entire root commit as an issue.
    // Do not count unattributed work as a finding.
    if (item.componentId === undefined) return [];
    const summary = normalizeIssueTitle(item.summary);
    const evidenceText = normalizeIssueEvidence(item.evidence);
    if (!summary || !evidenceText) return fail();
    const signature = `${item.componentId}|${[...references].sort().join(",")}`;
    if (seen.has(signature)) return fail();
    seen.add(signature);
    return [{ id: `react-issue-${index + 1}`, summary, severity: item.severity as ReactIssue["severity"],
      evidence: evidenceText, commits,
      componentId: item.componentId as string, component: componentName!,
      selfTimeMs, percentOfCommit: selfTimeMs !== undefined && selfTimeCommitDurationMs
        ? Math.round((selfTimeMs / selfTimeCommitDurationMs) * 1000) / 10 : undefined,
    }];
  });
  if (issues.length === 0) return noReactIssues();
  return { issues, noIssue: false, reasoning: (raw.reasoning as string).trim() };
}

export async function analyzeReactProfile(
  result: ReactProfileResult, cwd: string,
  run: (options: RunAgentOptions) => Promise<RunAgentResult>, budget = 16,
): Promise<ReactAnalysis & { usage: TokenUsage }> {
  const evidence = requireReactEvidence(result);
  if (withinReactBudget(evidence, budget)) return { ...noReactIssues(), usage: { ...ZERO_REACT_USAGE } };
  const prompt = reactAnalystPrompt(result, budget);
  const suppliedEvidence = { ...evidence, commits: (JSON.parse(prompt) as { commits: ReactCommitEvidence[] }).commits };
  let report: ReactAnalysis | undefined;
  const reportTool = defineTool({
    name: "report_react_issues", label: "Report React issues",
    description: "Submit only evidence-backed issues with a concise title and a 1-2 sentence description, or noIssue true and issues [] without reasoning.",
    parameters: Type.Object({ noIssue: Type.Boolean(), reasoning: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required only when issues is nonempty. Omit for zero issues." })),
      issues: Type.Array(Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 120, description: "Concise self-explanatory title naming the component and the delay. No profiler IDs." }),
        severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        evidence: Type.String({ minLength: 1, maxLength: 360, description: "At most 2 short sentences citing only the important timings. Omit IDs, keys, negligible siblings, and filler about other work being in budget." }), componentId: Type.String({ minLength: 1 }),
        commits: Type.Array(Type.Object({ rootID: Type.Integer({ minimum: 0 }), commitIndex: Type.Integer({ minimum: 0 }) }), { minItems: 1, maxItems: 50 }),
      }), { maxItems: 12 }),
    }),
    execute: async (_id, params) => {
      if (report !== undefined) throw new ReactProfileError(502, "The analyzer submitted more than one React report.");
      report = validateReactIssueReport(params, suppliedEvidence, budget);
      return { content: [{ type: "text" as const, text: "React report received. Finish without additional explanation." }], details: { received: true } };
    },
  });
  const response = await run({ label: "analyze-react", systemPrompt: REACT_ANALYST_SYSTEM_PROMPT,
    prompt, cwd, builtinTools: [], customTools: [reportTool], timeoutMs: 480_000 });
  if (report === undefined) {
    let raw: unknown;
    try { raw = JSON.parse(response.finalText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
    catch { throw new ReactProfileError(502, "The analyzer finished without a React issue report."); }
    report = validateReactIssueReport(raw, suppliedEvidence, budget);
  }
  return { ...discardSubBudgetReactIssues(report, evidence, budget), usage: response.usage };
}

import type { AnalysisModel, TokenUsage } from "./analysis";
import type { RunAgentOptions, RunAgentResult } from "./pi-agent";
import { ReactProfileError, type ReactProfileResult } from "./react-profile.ts";
import type { ReactCommitEvidence, ReactEvidence } from "./react-evidence.ts";
import { REACT_ANALYST_SYSTEM_PROMPT } from "./prompts.ts";

export interface ReactIssueComponent {
  componentId: string;
  component: string;
  severity: "low" | "medium" | "high";
  evidence: string;
  selfTimeMs: number;
  percentOfCommit: number;
}
export interface ReactIssue {
  id: string;
  summary: string;
  severity: "low" | "medium" | "high";
  evidence: string;
  commit: Pick<ReactCommitEvidence, "rootID" | "commitIndex" | "timestampMs" | "durationMs">;
  components: ReactIssueComponent[];
}
export interface ReactAnalysis {
  issues: ReactIssue[];
  noIssue: boolean;
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

function compactChanges(component: ReactCommitEvidence["components"][number]) {
  return {
    ...(component.causes.length === 1 && component.causes[0] === "unknown" ? {} : { causes: component.causes }),
    ...(component.changedProps.length ? { changedProps: component.changedProps } : {}),
    ...(component.changedHooks.length ? { changedHooks: component.changedHooks } : {}),
    ...(component.stateChanged === true ? { stateChanged: true as const } : {}),
  };
}

function promptEvidence(result: ReactProfileResult, budget: number) {
  const evidence = requireReactEvidence(result);
  const commits = evidence.commits.filter(commit => commit.durationMs > budget);
  const candidateIds = new Set(commits.flatMap(commit => commit.components.map(component => component.id)));
  const aggregates = new Map<string, ReactEvidence["componentsByTotalSelfDuration"][number]>();
  for (const rows of [evidence.componentsByTotalSelfDuration, evidence.slowestComponentsByAverageDuration, evidence.componentsByRenderCount]) {
    for (const component of rows) if (candidateIds.has(component.id) && !aggregates.has(component.id)) aggregates.set(component.id, component);
  }
  const compactComponent = (component: ReactCommitEvidence["components"][number]) => {
    const aggregate = aggregates.get(component.id);
    return {
      id: component.id,
      displayName: component.displayName,
      durationMs: component.durationMs,
      selfDurationMs: component.selfDurationMs,
      ...compactChanges(component),
      ...(aggregate ? { aggregate: {
        renderCount: aggregate.renderCount,
        selfRenderCount: aggregate.selfRenderCount,
        avgActualDurationMs: aggregate.avgActualDurationMs,
        maxActualDurationMs: aggregate.maxActualDurationMs,
        ...(aggregate.avgSelfDurationMs === null ? {} : {
          avgSelfDurationMs: aggregate.avgSelfDurationMs,
          maxSelfDurationMs: aggregate.maxSelfDurationMs,
        }),
      } } : {}),
    };
  };
  const payload = {
    summary: {
      rootCount: evidence.summary.rootCount,
      commitCount: evidence.summary.commitCount,
      peakCommitDurationMs: evidence.summary.peakCommitDurationMs,
    },
    thresholds: { commitDurationMs: budget },
    commitsOverBudget: evidence.commitDurations.filter(ms => ms > budget).length,
    omittedCommitCount: evidence.omittedCommitCount + evidence.commits.length - commits.length,
    textTruncated: false,
    commits: commits.map(commit => ({
      rootID: commit.rootID,
      commitIndex: commit.commitIndex,
      timestampMs: commit.timestampMs,
      durationMs: commit.durationMs,
      ...(commit.omittedComponentCount ? { omittedComponentCount: commit.omittedComponentCount } : {}),
      components: commit.components.map(compactComponent),
    })),
  };
  // Names and change lists are already capped by the extractor. Bound unusually verbose
  // recordings further without dropping commit identities or exact timings.
  if (JSON.stringify(payload).length > 200_000) {
    payload.textTruncated = true;
    for (const commit of payload.commits) {
      for (const component of commit.components) {
        if (component.changedProps) component.changedProps = component.changedProps.slice(0, 3).map(v => v.slice(0, 40));
        if (component.changedHooks) component.changedHooks = component.changedHooks.slice(0, 3).map(v => v.slice(0, 40));
      }
    }
    // Keep every selected commit. If text is still large, shed the lowest-self-time
    // candidates evenly and account for each omission.
    while (JSON.stringify(payload).length > 200_000) {
      let removed = false;
      for (const commit of payload.commits) {
        if (commit.components.length > 1) {
          commit.components.pop();
          commit.omittedComponentCount = (commit.omittedComponentCount ?? 0) + 1;
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

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function formatMs(value: number): string {
  return Number(value.toFixed(1)).toString();
}
export function reactIssueSeverity(selfTimeMs: number, commitDurationMs: number, budget: number): ReactIssue["severity"] {
  const share = selfTimeMs / commitDurationMs;
  if (selfTimeMs >= budget * 2 || share >= 0.5) return "high";
  if (selfTimeMs >= budget || share >= 0.25) return "medium";
  return "low";
}

const severityRank: Record<ReactIssue["severity"], number> = { low: 0, medium: 1, high: 2 };

function issueTitle(components: ReactIssueComponent[]): string {
  const names = components.slice(0, 3).map(component => component.component);
  const suffix = components.length > names.length ? ` and ${components.length - names.length} more` : "";
  return `Expensive render work in ${names.join(components.length === 2 ? " and " : ", ")}${suffix}`.slice(0, 120).trimEnd();
}

function finalizeReactIssues(groups: Map<string, { commit: ReactIssue["commit"]; components: ReactIssueComponent[] }>): ReactIssue[] {
  return [...groups.values()]
    .map(({ commit, components }) => {
      components.sort((a, b) => b.selfTimeMs - a.selfTimeMs || a.component.localeCompare(b.component));
      const severity = components.reduce<ReactIssue["severity"]>(
        (highest, component) => severityRank[component.severity] > severityRank[highest] ? component.severity : highest,
        "low",
      );
      const measuredSelfTimeMs = components.reduce((total, component) => total + component.selfTimeMs, 0);
      const percentOfCommit = commit.durationMs > 0 ? Math.round(measuredSelfTimeMs / commit.durationMs * 1000) / 10 : 0;
      const evidence = components.length === 1
        ? components[0].evidence
        : `${components.length} components used ${formatMs(measuredSelfTimeMs)} ms of measured self time, ${percentOfCommit}% of a ${formatMs(commit.durationMs)} ms over-budget React commit.`;
      return {
        id: `react-commit-${commit.rootID}-${commit.commitIndex}`,
        summary: issueTitle(components),
        severity,
        evidence,
        commit,
        components,
      };
    })
    .sort((a, b) => b.commit.durationMs - a.commit.durationMs || a.commit.rootID - b.commit.rootID || a.commit.commitIndex - b.commit.commitIndex);
}

export function reactIssueRemainingMs(issue: ReactIssue): number {
  return Math.max(0, issue.commit.durationMs - issue.components.reduce((total, component) => total + component.selfTimeMs, 0));
}

/** Upgrade component-centric saved findings from earlier releases into commit groups. */
export function normalizeStoredReactIssues(raw: unknown): ReactIssue[] {
  if (!Array.isArray(raw)) return [];
  const groups = new Map<string, { commit: ReactIssue["commit"]; components: ReactIssueComponent[] }>();
  const seen = new Set<string>();
  const add = (commit: ReactIssue["commit"], component: ReactIssueComponent) => {
    const key = `${commit.rootID}:${commit.commitIndex}`;
    const occurrence = `${component.componentId}|${key}`;
    if (seen.has(occurrence)) return;
    seen.add(occurrence);
    const group = groups.get(key);
    if (group) group.components.push(component);
    else groups.set(key, { commit, components: [component] });
  };

  for (const entry of raw) {
    if (!object(entry)) continue;
    if (object(entry.commit) && Array.isArray(entry.components)) {
      const commit = entry.commit;
      if (typeof commit.rootID !== "number" || typeof commit.commitIndex !== "number"
        || typeof commit.timestampMs !== "number" || typeof commit.durationMs !== "number") continue;
      for (const candidate of entry.components) {
        if (!object(candidate) || typeof candidate.componentId !== "string" || typeof candidate.component !== "string"
          || typeof candidate.selfTimeMs !== "number" || typeof candidate.percentOfCommit !== "number") continue;
        const severity = candidate.severity === "high" || candidate.severity === "medium" ? candidate.severity : "low";
        add(commit as ReactIssue["commit"], {
          componentId: candidate.componentId,
          component: candidate.component,
          severity,
          evidence: typeof candidate.evidence === "string" ? candidate.evidence : "",
          selfTimeMs: candidate.selfTimeMs,
          percentOfCommit: candidate.percentOfCommit,
        });
      }
      continue;
    }

    // Legacy findings stored one maximum component self time alongside several commits.
    if (typeof entry.componentId !== "string" || typeof entry.component !== "string"
      || typeof entry.selfTimeMs !== "number" || !Array.isArray(entry.commits) || entry.commits.length === 0) continue;
    const commits = entry.commits.filter((candidate): candidate is ReactIssue["commit"] => object(candidate)
      && typeof candidate.rootID === "number" && typeof candidate.commitIndex === "number"
      && typeof candidate.timestampMs === "number" && typeof candidate.durationMs === "number" && candidate.durationMs > 0);
    if (commits.length === 0) continue;
    const percent = typeof entry.percentOfCommit === "number" ? entry.percentOfCommit : undefined;
    const commit = percent === undefined ? commits[0] : commits.reduce((closest, candidate) => {
      const distance = Math.abs(entry.selfTimeMs as number / candidate.durationMs * 100 - percent);
      const closestDistance = Math.abs(entry.selfTimeMs as number / closest.durationMs * 100 - percent);
      return distance < closestDistance ? candidate : closest;
    });
    const percentOfCommit = percent ?? Math.round(entry.selfTimeMs / commit.durationMs * 1000) / 10;
    const severity = entry.severity === "high" || entry.severity === "medium" ? entry.severity : "low";
    add(commit, {
      componentId: entry.componentId,
      component: entry.component,
      severity,
      evidence: typeof entry.evidence === "string" ? entry.evidence : "",
      selfTimeMs: entry.selfTimeMs,
      percentOfCommit,
    });
  }
  return finalizeReactIssues(groups);
}

/** Model text can select findings, but cannot replace measured identities or timings. */
export function validateReactIssueReport(raw: unknown, evidence: ReactEvidence, budget: number): ReactAnalysis {
  const fail = (): never => { throw new ReactProfileError(502, "The analyzer returned an invalid React issue report."); };
  if (!object(raw) || !Array.isArray(raw.issues) || raw.issues.length > 12 || typeof raw.noIssue !== "boolean"
    || raw.noIssue !== (raw.issues.length === 0)) return fail();
  const commitsByID = new Map(evidence.commits.map(commit => [`${commit.rootID}:${commit.commitIndex}`, commit]));
  const seen = new Set<string>();
  const groups = new Map<string, { commit: ReactIssue["commit"]; components: ReactIssueComponent[] }>();
  for (const item of raw.issues) {
    if (!object(item) || (item.componentId !== undefined && typeof item.componentId !== "string")
      || !Array.isArray(item.commits) || !item.commits.length || item.commits.length > 50) return fail();
    const references = new Set();
    let attributedCommitCount = 0;
    for (const ref of item.commits) {
      if (!object(ref) || !Number.isSafeInteger(ref.rootID) || !Number.isSafeInteger(ref.commitIndex)) return fail();
      const key = `${ref.rootID}:${ref.commitIndex}`;
      const commit = commitsByID.get(key);
      if (!commit || references.has(key) || commit.durationMs <= budget) return fail();
      references.add(key);
      if (item.componentId === undefined) continue;
      const component = commit.components.find(c => c.id === item.componentId);
      if (!component || component.fiberID === commit.rootID) return fail();
      if (component.selfDurationMs === null || component.selfDurationMs <= 0) continue;
      const occurrence = `${item.componentId}|${key}`;
      if (seen.has(occurrence)) return fail();
      seen.add(occurrence);
      attributedCommitCount += 1;
      const percentOfCommit = Math.round((component.selfDurationMs / commit.durationMs) * 1000) / 10;
      const measuredCommit = {
        rootID: commit.rootID,
        commitIndex: commit.commitIndex,
        timestampMs: commit.timestampMs,
        durationMs: commit.durationMs,
      };
      const issueComponent: ReactIssueComponent = {
        componentId: item.componentId as string,
        component: component.displayName,
        severity: reactIssueSeverity(component.selfDurationMs, commit.durationMs, budget),
        evidence: `${component.displayName} used ${formatMs(component.selfDurationMs)} ms self time, ${percentOfCommit}% of a ${formatMs(commit.durationMs)} ms over-budget React render.`,
        selfTimeMs: component.selfDurationMs,
        percentOfCommit,
      };
      const group = groups.get(key);
      if (group) group.components.push(issueComponent);
      else groups.set(key, { commit: measuredCommit, components: [issueComponent] });
    }
    // Older model responses may still report an entire root commit as an issue.
    // Do not count unattributed work as a finding.
    if (item.componentId !== undefined && attributedCommitCount === 0) return fail();
  }
  const issues = finalizeReactIssues(groups);
  if (issues.length === 0) return noReactIssues();
  return { issues, noIssue: false };
}

export async function analyzeReactProfile(
  result: ReactProfileResult, cwd: string,
  run: (options: RunAgentOptions) => Promise<RunAgentResult>, budget = 16,
): Promise<ReactAnalysis & { usage: TokenUsage; model?: AnalysisModel }> {
  const evidence = requireReactEvidence(result);
  if (withinReactBudget(evidence, budget)) return { ...noReactIssues(), usage: { ...ZERO_REACT_USAGE } };
  const prompt = reactAnalystPrompt(result, budget);
  const suppliedPayload = JSON.parse(prompt) as {
    thresholds: { commitDurationMs: number };
    commitsOverBudget: number;
    textTruncated: boolean;
    commits: Array<Pick<ReactCommitEvidence, "rootID" | "commitIndex">>;
    omittedCommitCount: number;
  };
  const suppliedCommitIds = new Set(suppliedPayload.commits.map(commit => `${commit.rootID}:${commit.commitIndex}`));
  const suppliedEvidence = { ...evidence, commits: evidence.commits.filter(commit => suppliedCommitIds.has(`${commit.rootID}:${commit.commitIndex}`)) };
  const inputBreakdown = {
    profileEvidence: {
      rootCount: evidence.summary.rootCount,
      commitCount: evidence.summary.commitCount,
      totalCommitRenderDurationMs: evidence.summary.totalCommitRenderDurationMs,
      peakCommitDurationMs: evidence.summary.peakCommitDurationMs,
      completeDurationCount: evidence.commitDurations.length,
      retainedCommitCountBeforeBudgetFilter: evidence.commits.length,
      omittedCommitCountBeforeBudgetFilter: evidence.omittedCommitCount,
    },
    transformations: {
      commitDurationBudgetMs: suppliedPayload.thresholds.commitDurationMs,
      completeDurationListSupplied: false,
      subBudgetRetainedCommitsRemoved: evidence.commits.filter((commit) => commit.durationMs <= budget).length,
      aggregateViewsMergedIntoCandidates: true,
      defaultAndRedundantFieldsRemoved: true,
      textTruncated: suppliedPayload.textTruncated,
    },
    suppliedPayload: {
      commitsOverBudget: suppliedPayload.commitsOverBudget,
      suppliedCommitCount: suppliedPayload.commits.length,
      omittedCommitCount: suppliedPayload.omittedCommitCount,
      commits: suppliedPayload.commits.map((commit) => ({
        rootID: commit.rootID,
        commitIndex: commit.commitIndex,
      })),
      serializedBytes: Buffer.byteLength(prompt, "utf8"),
    },
  };
  const response = await run({ label: "analyze-react", systemPrompt: REACT_ANALYST_SYSTEM_PROMPT,
    prompt, cwd, builtinTools: [], customTools: [], maxOutputTokens: 4_096, timeoutMs: 480_000, inputBreakdown });
  let raw: unknown;
  try { raw = JSON.parse(response.finalText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
  catch { throw new ReactProfileError(502, "The analyzer finished without a React issue report."); }
  const report = validateReactIssueReport(raw, suppliedEvidence, budget);
  return { ...discardSubBudgetReactIssues(report, evidence, budget), usage: response.usage, ...(response.model ? { model: response.model } : {}) };
}

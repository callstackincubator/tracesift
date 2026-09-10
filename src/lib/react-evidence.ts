import { ReactProfileError, type ReactComponent } from "./react-profile.ts";

export interface ReactChanges {
  causes: string[];
  changedProps: string[];
  changedHooks: string[];
  stateChanged: true | null;
}
export interface ReactCommitReference { rootID: number; commitIndex: number }
export interface ReactCommitComponent extends ReactChanges {
  id: string;
  rootID: number;
  fiberID: number;
  displayName: string;
  durationMs: number;
  selfDurationMs: number | null;
}
export interface ReactCommitEvidence extends ReactCommitReference {
  timestampMs: number;
  durationMs: number;
  components: ReactCommitComponent[];
  omittedComponentCount: number;
  updaters: string[];
  omittedUpdaterCount: number;
}
export interface ReactEvidence {
  evidenceVersion: 1;
  summary: {
    rootCount: number;
    commitCount: number;
    totalCommitRenderDurationMs: number;
    peakCommitDurationMs: number | null;
  };
  commitDurations: number[];
  commits: ReactCommitEvidence[];
  omittedCommitCount: number;
  slowestComponentsByAverageDuration: (ReactComponent & ReactChanges)[];
  componentsByRenderCount: (ReactComponent & ReactChanges)[];
  componentsByTotalSelfDuration: (ReactComponent & ReactChanges)[];
  omittedAggregateComponentCount: number;
}

export function parseFrameBudget(form: FormData): number {
  const raw = form.get("frameBudgetMs");
  const budget = raw === null ? 16 : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(budget) || budget <= 0) throw new ReactProfileError(400, "frameBudgetMs must be a finite positive number.");
  return budget;
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const duration = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => duration(v) && Number.isSafeInteger(v);
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => typeof s === "string" && s.length <= 200);
const below = (a: number, b: number) => a < b && b - a > 1e-10 * Math.max(1, a, b);
const causes = new Set(["unknown", "first-mount", "context-changed", "props-changed", "state-changed", "hooks-changed"]);
function validChanges(v: Record<string, unknown>): boolean {
  return strings(v.causes, 6) && v.causes.length > 0 && v.causes.every(c => causes.has(c))
    && strings(v.changedProps, 20) && strings(v.changedHooks, 20) && (v.stateChanged === true || v.stateChanged === null);
}
function validIdentity(v: Record<string, unknown>, rootID: number | null): boolean {
  return integer(v.rootID) && integer(v.fiberID) && v.id === `${v.rootID}:${v.fiberID}`
    && (rootID === null || v.rootID === rootID) && typeof v.displayName === "string" && v.displayName.length > 0 && v.displayName.length <= 200;
}

/** Validate the optional executable evidence separately from the unchanged ranking contract. */
export function validateReactEvidence(raw: unknown, rootID: number | null): ReactEvidence {
  const fail = (): never => { throw new ReactProfileError(502, "The React profiler returned invalid analysis evidence."); };
  if (!object(raw) || raw.evidenceVersion !== 1 || !object(raw.summary) || !Array.isArray(raw.commitDurations)
    || !Array.isArray(raw.commits) || raw.commits.length > 50 || !integer(raw.omittedCommitCount)
    || !integer(raw.omittedAggregateComponentCount)) return fail();
  const summary = raw.summary;
  if (!integer(summary.rootCount) || !integer(summary.commitCount) || !duration(summary.totalCommitRenderDurationMs)
    || (rootID !== null && summary.rootCount > 1) || raw.commitDurations.length !== summary.commitCount
    || !raw.commitDurations.every(duration) || raw.omittedCommitCount !== summary.commitCount - raw.commits.length
    || raw.commits.length !== Math.min(50, summary.commitCount)) return fail();
  const durations = raw.commitDurations as number[];
  const peak = durations.reduce<number | null>((max, n) => Math.max(max ?? 0, n), null);
  if (summary.peakCommitDurationMs !== peak || summary.totalCommitRenderDurationMs !== durations.reduce((a, b) => a + b, 0)) return fail();
  const expected = [...durations].sort((a, b) => b - a).slice(0, 50);
  const commitIDs = new Set<string>();
  for (const [index, commit] of raw.commits.entries()) {
    if (!object(commit) || !integer(commit.rootID) || (rootID !== null && commit.rootID !== rootID)
      || !integer(commit.commitIndex) || commit.commitIndex >= summary.commitCount || !duration(commit.timestampMs)
      || commit.durationMs !== expected[index] || !Array.isArray(commit.components) || commit.components.length > 10
      || !integer(commit.omittedComponentCount) || !integer(commit.omittedUpdaterCount) || !strings(commit.updaters, 20)) return fail();
    const id = `${commit.rootID}:${commit.commitIndex}`;
    if (commitIDs.has(id)) return fail();
    commitIDs.add(id);
    const fiberIDs = new Set();
    for (const component of commit.components) {
      if (!object(component) || !validIdentity(component, commit.rootID) || !validChanges(component)
        || !duration(component.durationMs) || !(component.selfDurationMs === null || duration(component.selfDurationMs))
        || fiberIDs.has(component.id)) return fail();
      fiberIDs.add(component.id);
    }
  }
  for (const field of ["slowestComponentsByAverageDuration", "componentsByRenderCount", "componentsByTotalSelfDuration"]) {
    const entries = raw[field];
    if (!Array.isArray(entries) || entries.length > 15) return fail();
    const ids = new Set();
    for (const entry of entries) {
      if (!object(entry) || !validIdentity(entry, rootID) || !validChanges(entry) || ids.has(entry.id)
        || !integer(entry.renderCount) || entry.renderCount < 1 || !integer(entry.selfRenderCount) || entry.selfRenderCount > entry.renderCount
        || typeof entry.metadataMissing !== "boolean" || !(entry.elementType === null || integer(entry.elementType))
        || !(entry.key === null || (typeof entry.key === "string" && entry.key.length <= 200))
        || !duration(entry.totalActualDurationMs) || entry.avgActualDurationMs !== entry.totalActualDurationMs / entry.renderCount
        || !duration(entry.maxActualDurationMs) || below(entry.maxActualDurationMs, entry.avgActualDurationMs as number)
        || !object(entry.peakCommit) || entry.peakCommit.rootID !== entry.rootID || !integer(entry.peakCommit.commitIndex)
        || entry.peakCommit.commitIndex >= summary.commitCount || !duration(entry.peakCommit.timestampMs)) return fail();
      if (entry.selfRenderCount !== entry.renderCount) {
        if (entry.totalSelfDurationMs !== null || entry.avgSelfDurationMs !== null || entry.maxSelfDurationMs !== null) return fail();
      } else if (!duration(entry.totalSelfDurationMs) || entry.avgSelfDurationMs !== entry.totalSelfDurationMs / entry.renderCount
        || !duration(entry.maxSelfDurationMs) || below(entry.maxSelfDurationMs, entry.avgSelfDurationMs as number)) return fail();
      ids.add(entry.id);
    }
  }
  return raw as unknown as ReactEvidence;
}

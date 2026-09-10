import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { validateReactEvidence, type ReactEvidence } from "./react-evidence.ts";

export class ReactProfileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReactProfileError";
    this.status = status;
  }
}

export interface ReactProfileOptions {
  limit: number;
  rootID: number | null;
  componentName: string | null;
  minAvgDurationMs: number;
}
export interface ReactComponent {
  id: string;
  rootID: number;
  fiberID: number;
  displayName: string;
  metadataMissing: boolean;
  elementType: number | null;
  key: string | null;
  renderCount: number;
  totalActualDurationMs: number;
  avgActualDurationMs: number;
  maxActualDurationMs: number;
  selfRenderCount: number;
  totalSelfDurationMs: number | null;
  avgSelfDurationMs: number | null;
  maxSelfDurationMs: number | null;
  peakCommit: { rootID: number; commitIndex: number; timestampMs: number };
}
export interface ReactProfileResult {
  schemaVersion: 1;
  profileType: "react";
  ranking: "avgActualDurationMs";
  evidence?: ReactEvidence;
  filters: ReactProfileOptions;
  summary: {
    rootCount: number;
    commitCount: number;
    totalCommitRenderDurationMs: number;
    candidateCount: number;
    matchingCount: number;
    omittedCount: number;
  };
  components: ReactComponent[];
}

export function parseReactProfileOptions(form: FormData): ReactProfileOptions {
  function numeric(name: string, fallback: number | null, max: number, integer = true): number | null {
    const raw = form.get(name);
    if (raw === null) return fallback;
    const number = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(number) || number < 0 || number > max || (integer && !Number.isSafeInteger(number))) {
      throw new ReactProfileError(400, `Invalid ${name}.`);
    }
    return number;
  }
  const limit = numeric("limit", 10, 12)!;
  if (limit < 1) throw new ReactProfileError(400, "limit must be between 1 and 12.");
  const componentName = form.get("componentName");
  if (componentName !== null && (typeof componentName !== "string" || !componentName.trim() || componentName.length > 200)) {
    throw new ReactProfileError(400, "componentName must contain 1–200 characters.");
  }
  return {
    limit, componentName,
    rootID: numeric("rootId", null, Number.MAX_SAFE_INTEGER),
    minAvgDurationMs: numeric("minAvgDurationMs", 0, Number.MAX_VALUE, false)!,
  };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const below = (a: number, b: number) => a < b && b - a > 1e-10 * Math.max(1, a, b);
const nullableDuration = (value: unknown) => value === null || nonnegative(value);

/** Check the executable's wire contract before treating its output as evidence. */
export function validateReactProfileResult(raw: unknown, options: ReactProfileOptions): ReactProfileResult {
  const fail = (): never => { throw new ReactProfileError(502, "The React profiler returned invalid output."); };
  if (!object(raw) || raw.schemaVersion !== 1 || raw.profileType !== "react" || raw.ranking !== "avgActualDurationMs"
    || !object(raw.filters) || Object.entries(options).some(([key, value]) => raw.filters && (raw.filters as Record<string, unknown>)[key] !== value)
    || !object(raw.summary) || !Array.isArray(raw.components) || raw.components.length > options.limit) return fail();
  const summary = raw.summary;
  for (const name of ["rootCount", "commitCount", "candidateCount", "matchingCount", "omittedCount"]) if (!integer(summary[name])) return fail();
  if (!nonnegative(summary.totalCommitRenderDurationMs)
    || (summary.candidateCount as number) < (summary.matchingCount as number)
    || summary.omittedCount !== (summary.matchingCount as number) - raw.components.length) return fail();
  const ids = new Set();
  for (const entry of raw.components) {
    if (!object(entry) || !integer(entry.rootID) || !integer(entry.fiberID) || entry.id !== `${entry.rootID}:${entry.fiberID}`
      || ids.has(entry.id) || typeof entry.displayName !== "string" || !entry.displayName
      || typeof entry.metadataMissing !== "boolean" || !(entry.elementType === null || integer(entry.elementType))
      || !(entry.key === null || typeof entry.key === "string") || !integer(entry.renderCount) || entry.renderCount < 1
      || !integer(entry.selfRenderCount) || entry.selfRenderCount > entry.renderCount) return fail();
    ids.add(entry.id);
    for (const name of ["totalActualDurationMs", "avgActualDurationMs", "maxActualDurationMs"]) if (!nonnegative(entry[name])) return fail();
    for (const name of ["totalSelfDurationMs", "avgSelfDurationMs", "maxSelfDurationMs"]) if (!nullableDuration(entry[name])) return fail();
    if (!object(entry.peakCommit) || entry.peakCommit.rootID !== entry.rootID || !integer(entry.peakCommit.commitIndex)
      || entry.peakCommit.commitIndex >= (summary.commitCount as number) || !nonnegative(entry.peakCommit.timestampMs)) return fail();
    if (entry.avgActualDurationMs !== (entry.totalActualDurationMs as number) / entry.renderCount
      || below(entry.maxActualDurationMs as number, entry.avgActualDurationMs as number)
      || (entry.avgActualDurationMs as number) <= 0 || (entry.avgActualDurationMs as number) < options.minAvgDurationMs
      || (options.rootID !== null && entry.rootID !== options.rootID)
      || (options.componentName !== null && !entry.displayName.toLowerCase().includes(options.componentName.toLowerCase()))) return fail();
    if (entry.selfRenderCount !== entry.renderCount) {
      if (entry.totalSelfDurationMs !== null || entry.avgSelfDurationMs !== null || entry.maxSelfDurationMs !== null) return fail();
    } else if (!nonnegative(entry.totalSelfDurationMs) || entry.avgSelfDurationMs !== entry.totalSelfDurationMs / entry.renderCount
      || !nonnegative(entry.maxSelfDurationMs) || below(entry.maxSelfDurationMs, entry.avgSelfDurationMs as number)) return fail();
  }
  const result = raw as unknown as ReactProfileResult;
  for (let i = 1; i < result.components.length; i++) {
    const a = result.components[i - 1], b = result.components[i];
    if ((b.avgActualDurationMs - a.avgActualDurationMs || b.maxActualDurationMs - a.maxActualDurationMs
      || a.rootID - b.rootID || a.fiberID - b.fiberID) > 0) return fail();
  }
  return result;
}

/** Resolve only; importing this package would execute its CLI in the server. */
export function resolveReactProfilerCli(): string {
  return createRequire(path.join(process.cwd(), "package.json")).resolve("agent-react-devtools");
}

export async function extractReactProfile(
  file: string, options: ReactProfileOptions, signal?: AbortSignal,
  execution: { cliPath?: string; timeoutMs?: number; maxBuffer?: number; analysisEvidence?: boolean } = {},
): Promise<ReactProfileResult> {
  if (signal?.aborted) throw new ReactProfileError(499, "React profile analysis cancelled.");
  const args = [execution.cliPath ?? resolveReactProfilerCli(), "profile", "slow", "--file", file, "--json", "--limit", String(options.limit)];
  if (execution.analysisEvidence) args.push("--analysis-evidence");
  if (options.rootID !== null) args.push("--root-id", String(options.rootID));
  if (options.componentName !== null) args.push(`--component-name=${options.componentName}`);
  args.push("--min-avg-duration", String(options.minAvgDurationMs));
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, args, {
      shell: false, encoding: "utf8", timeout: execution.timeoutMs ?? 30_000,
      maxBuffer: execution.maxBuffer ?? (execution.analysisEvidence ? 8 : 1) * 1024 * 1024, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new ReactProfileError(499, "React profile analysis cancelled."));
      if (error) {
        if (error.code === 2) return reject(new ReactProfileError(400, stderr.trim().slice(0, 1000) || "Invalid React profile."));
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new ReactProfileError(502, "React profiler output exceeded its limit."));
        if (error.killed) return reject(new ReactProfileError(504, "React profile extraction timed out."));
        return reject(new ReactProfileError(500, "The React profiler executable failed."));
      }
      resolve(stdout);
    });
    function abort() { child.kill("SIGKILL"); }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  let raw: unknown;
  try { raw = JSON.parse(stdout); }
  catch { throw new ReactProfileError(502, "The React profiler returned invalid JSON."); }
  const result = validateReactProfileResult(raw, options);
  if (execution.analysisEvidence) result.evidence = validateReactEvidence(result.evidence, options.rootID);
  return result;
}

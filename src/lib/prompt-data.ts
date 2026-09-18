import type { Hotspot } from "./analysis";
import type { Bottleneck } from "./bottlenecks";
import type { ReactIssue } from "./react-analyzer";

export const MAX_GROUP_PROMPT_BYTES = 6_000;
const MAX_FUNCTIONS = 8;
const MAX_STACK_FRAMES = 24;

function compactText(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 140)}…${text.slice(-59)}`;
}

/** Keep names from URL-backed frames, but never present a URL as a source file. */
function sourceFrame(label: string): { name: string; location?: string } {
  const match = /^(.*) \((.*):\d+:\d+\)$/.exec(label);
  if (!match) return { name: label };
  const [, name, location] = match;
  const readable = !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(location)
    || /^[a-z]:[\\/]/i.test(location);
  return {
    name,
    location: readable && /\.(?:[cm]?[jt]sx?|vue|svelte)(?::|$)/i.test(location)
      ? label.slice(name.length + 2, -1)
      : undefined,
  };
}

function compactStack(stack: string[]): string[] {
  const parsed = stack.map(sourceFrame);
  const selected = new Set<number>();
  const add = (index: number) => {
    if (index >= 0 && index < stack.length && selected.size < MAX_STACK_FRAMES) selected.add(index);
  };
  // Anchor the hot work and outer context, then prioritize source-bearing callers
  // and event handlers anywhere in the stack (including directly below dispatch).
  [0, 1, 2, stack.length - 2, stack.length - 1].forEach(add);
  parsed.forEach((frame, index) => {
    if (/^_?on[A-Z]/.test(frame.name) || parsed[index + 1]?.name === "executeDispatch") add(index);
  });
  parsed.forEach((frame, index) => { if (frame.location && !/node_modules/.test(frame.location)) add(index); });
  parsed.forEach((frame, index) => {
    if (!/^(?:\(anonymous\)|dispatch|executeDispatch|batchedUpdates|processDispatch|perform|workLoop|flush|runWith)/.test(frame.name)) add(index);
  });
  parsed.forEach((_, index) => add(index));
  const result: string[] = [];
  let previous = -1;
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (index > previous + 1) result.push("… (intermediate frames omitted)");
    const { name, location } = parsed[index];
    result.push(compactText(location ? `${name} (${location})` : name));
    previous = index;
  }
  return result;
}

/** Separate bounded agent context from the complete measurements retained for the UI. */
export function bottleneckPromptData(group: Bottleneck) {
  const data = {
    id: group.id,
    groupingCaller: compactText(group.title),
    combinedTimeMs: group.combinedTimeMs,
    percentOfTotal: group.percentOfTotal,
    stack: compactStack(group.stack),
    functionCount: group.functions.length,
    omittedFunctionCount: 0,
    omittedSelfTimeMs: 0,
    contextTruncated: true,
    functions: group.functions.slice(0, MAX_FUNCTIONS).map((fn) => ({
      id: fn.id,
      title: compactText(fn.title),
      selfTimeMs: fn.selfTimeMs,
      percentOfGroup: fn.percentOfGroup,
      stack: compactStack(fn.stack),
      stackIsRepresentative: true,
    })),
  };
  const updateOmissions = () => {
    data.omittedFunctionCount = group.functions.length - data.functions.length;
    data.omittedSelfTimeMs = Math.max(0, group.combinedTimeMs - data.functions.reduce((sum, fn) => sum + fn.selfTimeMs, 0));
  };
  updateOmissions();
  // Measure serialized UTF-8 bytes, including JSON escaping, rather than assuming
  // a characters-per-token ratio. At most 12 groups yields roughly 72 KB of data.
  while (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_GROUP_PROMPT_BYTES) {
    if (data.functions.length > 1) data.functions.pop();
    else if (data.functions[0]?.stack.length) data.functions[0].stack.pop();
    else if (data.stack.length) data.stack.pop();
    else throw new Error("Bottleneck metadata exceeds the agent context budget.");
    updateOmissions();
  }
  return data;
}

export function analysisPromptData(groups: Bottleneck[]) {
  return groups.slice(0, 12).map(bottleneckPromptData);
}

export function compactAnnotation(text: string): string {
  return text.slice(0, 2_000);
}

/** Carry the recorded caller evidence forward with the existing conclusion. */
export function debugPromptData(hotspot: Hotspot) {
  const shortlisted = new Set(hotspot.supportingFunctionIds);
  const context = bottleneckPromptData({
    ...hotspot,
    title: hotspot.groupingCaller,
    functions: hotspot.functions.filter((fn) => shortlisted.has(fn.id)),
  });
  return {
    summary: compactAnnotation(hotspot.summary.join("\n")),
    groupingCaller: context.groupingCaller,
    stack: context.stack,
    functions: context.functions,
  };
}

/** The prompt writer needs the existing React finding, not another profile analysis. */
export function debugReactIssuePromptData(issue: ReactIssue) {
  return {
    summary: compactAnnotation(issue.summary),
    evidence: compactAnnotation(issue.evidence),
    component: compactText(issue.component),
    severity: issue.severity,
    commits: issue.commits.slice(0, MAX_FUNCTIONS).map((commit) => ({
      commitIndex: commit.commitIndex,
      durationMs: commit.durationMs,
    })),
  };
}

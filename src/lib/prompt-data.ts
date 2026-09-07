import type { Hotspot } from "./analysis";
import type { Bottleneck } from "./bottlenecks";

export const MAX_GROUP_PROMPT_BYTES = 6_000;
const MAX_FUNCTIONS = 8;
const MAX_STACK_FRAMES = 6;

function compactText(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 140)}…${text.slice(-59)}`;
}

function compactStack(stack: string[]): string[] {
  // Retain both the hot leaf and the owning caller when the path is deep.
  const frames = stack.length > MAX_STACK_FRAMES
    ? [...stack.slice(0, 3), "… (intermediate frames omitted)", ...stack.slice(-2)]
    : stack;
  return frames.map(compactText);
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

/** The prompt writer needs the existing conclusion, not another profile analysis. */
export function debugPromptData(hotspot: Hotspot) {
  const shortlisted = new Set(hotspot.supportingFunctionIds);
  return {
    summary: compactAnnotation(hotspot.summary),
    functions: hotspot.functions
      .filter((fn) => shortlisted.has(fn.id))
      .slice(0, MAX_FUNCTIONS)
      .map((fn) => compactText(fn.title)),
  };
}

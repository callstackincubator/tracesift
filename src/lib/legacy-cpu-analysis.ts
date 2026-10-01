/**
 * The CPU engine the call-tree cards replace, kept reachable for comparison.
 *
 * Set `TRACESIFT_CPU_ENGINE=legacy` to run a suspicious profile through the old
 * grouping and its analyst agent and check that the current engine did not lose
 * a real finding. All three engines stay reachable side by side: a profiler
 * that cannot be cross-examined is one nobody trusts the second time it says
 * something surprising.
 */

import { analyzeCpuBottlenecks } from "./cpu-analyzer";
import { analysisPromptData } from "./prompt-data";
import type { Bottleneck } from "./bottlenecks";
import type { AnalysisModel, Hotspot, TokenUsage } from "./analysis";

export function legacyEngineRequested(): boolean {
  return process.env.TRACESIFT_CPU_ENGINE === "legacy";
}

/**
 * `TRACESIFT_CPU_ENGINE=cards` serves the node-descent cards in place of the
 * task cards that replaced them. All three engines read the same upload, so a
 * profile whose task cards look wrong can be run through each and compared
 * without rebuilding anything.
 */
export function nodeCardEngineRequested(): boolean {
  return process.env.TRACESIFT_CPU_ENGINE === "cards";
}

export async function runLegacyCpuAnalysis(
  bottlenecks: Bottleneck[],
  totalMs: number,
  dir: string,
  sampleCount: number,
  extractedHotspotCount: number,
): Promise<{ hotspots: Hotspot[]; usage: TokenUsage; model?: AnalysisModel }> {
  const suppliedGroups = analysisPromptData(bottlenecks);
  const inputBreakdown = {
    profile: {
      totalDurationMs: totalMs,
      sampleCount,
      extractedHotspotCount,
      actionableBottleneckCount: bottlenecks.length,
    },
    selection: {
      suppliedGroupCount: suppliedGroups.length,
      omittedGroupCount: Math.max(0, bottlenecks.length - suppliedGroups.length),
    },
    groups: suppliedGroups.map((group) => ({
      id: group.id,
      groupingCaller: group.groupingCaller,
      combinedTimeMs: group.combinedTimeMs,
      percentOfTotal: group.percentOfTotal,
      suppliedFunctionCount: group.functions.length,
      omittedFunctionCount: group.omittedFunctionCount,
      otherSelfTimeMs: group.otherSelfTimeMs,
    })),
  };
  return analyzeCpuBottlenecks(bottlenecks, totalMs, dir, inputBreakdown);
}

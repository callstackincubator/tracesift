import { normalizeHotspots, type AnalysisModel, type Hotspot, type TokenUsage } from "./analysis.ts";
import type { Bottleneck } from "./bottlenecks.ts";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "./pi-agent.ts";
import { ANALYST_SYSTEM_PROMPT, analystUserPrompt } from "./prompts.ts";
import { analysisPromptData } from "./prompt-data.ts";

type CpuAgentRunner = (options: RunAgentOptions) => Promise<RunAgentResult>;

export class CpuAnalysisError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CpuAnalysisError";
    this.status = status;
  }
}

function parsedReport(value: unknown): { hotspots: unknown[] } | null {
  if (!value || typeof value !== "object") return null;
  const hotspots = (value as { hotspots?: unknown }).hotspots;
  return Array.isArray(hotspots) && hotspots.length > 0 ? { hotspots } : null;
}

/** Parse an exact JSON response, tolerating only a Markdown fence or surrounding prose. */
export function parseCpuHotspotReport(text: string): { hotspots: unknown[] } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^\s*```(?:json)?\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
  try {
    const exact = parsedReport(JSON.parse(unfenced));
    if (exact) return exact;
  } catch {
    // Scan below so providers that add a short preamble remain recoverable.
  }

  for (let start = unfenced.indexOf("{"); start >= 0; start = unfenced.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < unfenced.length; end += 1) {
      const character = unfenced[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const report = parsedReport(JSON.parse(unfenced.slice(start, end + 1)));
          if (report) return report;
        } catch {
          // This object was not the report; continue with the next opening brace.
        }
        break;
      }
    }
  }
  return null;
}

export async function analyzeCpuBottlenecks(
  groups: Bottleneck[],
  totalMs: number,
  cwd: string,
  inputBreakdown?: unknown,
  run: CpuAgentRunner = runAgent,
): Promise<{ hotspots: Hotspot[]; usage: TokenUsage; model?: AnalysisModel }> {
  const suppliedGroups = analysisPromptData(groups);
  const response = await run({
    label: "analyze",
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    prompt: analystUserPrompt(groups, totalMs, suppliedGroups),
    cwd,
    builtinTools: [],
    customTools: [],
    maxOutputTokens: 4_096,
    timeoutMs: 480_000,
    inputBreakdown,
  });
  const report = parseCpuHotspotReport(response.finalText);
  if (!report) {
    throw new CpuAnalysisError(502, "The agent finished without returning a valid hotspot report. Try again.");
  }
  const { hotspots } = normalizeHotspots(report.hotspots, totalMs, groups);
  if (hotspots.length === 0) {
    throw new CpuAnalysisError(502, "No meaningful hotspots were found in this profile.");
  }
  return { hotspots, usage: response.usage, ...(response.model ? { model: response.model } : {}) };
}

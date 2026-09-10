import { runAgent } from "@/lib/pi-agent";
import { analyzeReactProfile } from "@/lib/react-analyzer";
import { createReactAnalysisHandler } from "@/lib/react-analysis-handler";
import { extractReactProfile } from "@/lib/react-profile";

export const runtime = "nodejs";

export const POST = createReactAnalysisHandler({
  extract: extractReactProfile,
  analyze: (result, cwd, budget) => analyzeReactProfile(result, cwd, runAgent, budget),
});

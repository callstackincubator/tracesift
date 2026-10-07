import { runAgent } from "@/lib/pi-agent";
import { analyzeReactProfile } from "@/lib/react-analyzer";
import { createReactAnalysisHandler } from "@/lib/react-analysis-handler";
import { parseReactExport } from "@/lib/react-commit-tree";
import { extractReactProfile } from "@/lib/react-profile";

export const runtime = "nodejs";

/**
 * The measured engine, unless the old one is asked for by name.
 *
 * `TRACESIFT_REACT_ENGINE=analyzer` restores the model path — the
 * `agent-react-devtools` extraction plus one analyzer run that selects which
 * component in which commit is the finding. It is the same escape hatch
 * `TRACESIFT_CPU_ENGINE` leaves on the CPU side, and it is the only way a
 * React profile reaches a model now.
 */
export const POST = process.env.TRACESIFT_REACT_ENGINE === "analyzer"
  ? createReactAnalysisHandler({
    extract: extractReactProfile,
    analyze: (result, cwd, budget) => analyzeReactProfile(result, cwd, runAgent, budget),
  })
  : createReactAnalysisHandler({ parse: parseReactExport });

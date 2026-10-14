import { timingSafeEqual } from "node:crypto";

import { coerceCdpProfile } from "./js-profile.ts";
import { parseReactExport } from "./react-commit-tree.ts";

export const INTEGRATION_API_VERSION = 1;

export type IntegrationProfileType = "cpu" | "react";

export function integrationEngineConflict(
  profileType: IntegrationProfileType,
  environment?: Partial<Record<"TRACESIFT_CPU_ENGINE" | "TRACESIFT_REACT_ENGINE", string>>,
): string | undefined {
  const env = environment ?? process.env;
  if (profileType === "cpu" && (env.TRACESIFT_CPU_ENGINE === "legacy" || env.TRACESIFT_CPU_ENGINE === "cards")) {
    return `Integration API v1 requires the measured CPU task-card engine. Unset TRACESIFT_CPU_ENGINE and restart TraceSift (current value: ${env.TRACESIFT_CPU_ENGINE}).`;
  }
  if (profileType === "react" && env.TRACESIFT_REACT_ENGINE === "analyzer") {
    return "Integration API v1 requires the measured React card engine. Unset TRACESIFT_REACT_ENGINE and restart TraceSift (current value: analyzer).";
  }
}

export function authorizeIntegrationRequest(request: Request): Response | undefined {
  const expected = process.env.TRACE_SIFT_INTEGRATION_TOKEN;
  if (!expected) {
    return Response.json({ error: "The TraceSift integration API is not enabled for this server." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
}

/** Shared response shape for every Integration API v1 route. */
export function integrationJson(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

/** The one message every route uses when `findAnalysis` can't locate the id. */
export function analysisNotFoundResponse(): Response {
  return integrationJson({ error: "This analysis is no longer available (it may have expired). Run it again." }, 404);
}

/** Detect only formats the existing analyzers can actually parse. */
export function detectIntegrationProfileType(raw: unknown): IntegrationProfileType {
  let cpu = false;
  let react = false;
  try { coerceCdpProfile(raw); cpu = true; } catch { /* not a supported CPU shape */ }
  try { parseReactExport(raw); react = true; } catch { /* not a supported React shape */ }
  if (cpu && react) throw new Error("The profile matches both CPU and React export formats. Set profileType explicitly.");
  if (cpu) return "cpu";
  if (react) return "react";
  throw new Error("The uploaded JSON is not a supported CPU profile or React DevTools profiling export.");
}

/**
 * One card without the two fields only a drill-down reads.
 *
 * A task card ships the task's call tree untruncated, which is several
 * megabytes on a long task, and an analysis carries up to twelve of them. None
 * of it is drawn on a card, and a client that renders cards inline — in a chat
 * transcript, say — would be handed tens of megabytes to show a bar and a
 * legend. `/api/integration/v1/task` serves the whole task to whoever opens
 * one, which is the only reader those fields have.
 */
const DRILL_DOWN_ONLY = ["tree", "timeline"];

function summarizedCard(card: unknown): unknown {
  if (typeof card !== "object" || card === null) return card;
  return Object.fromEntries(Object.entries(card).filter(([key]) => !DRILL_DOWN_ONLY.includes(key)));
}

export function normalizedIntegrationAnalysis(result: Record<string, unknown>) {
  const profileType = result.profileType as IntegrationProfileType;
  if (profileType === "react") {
    const reactCards = result.reactCards as { cards?: unknown[] } | undefined;
    return {
      apiVersion: INTEGRATION_API_VERSION,
      analysisId: result.analysisId,
      profileType,
      title: result.title,
      summary: result.summary,
      cards: reactCards?.cards ?? result.issues ?? [],
    };
  }
  const taskCards = result.taskCards as { cards?: unknown[]; taskCount?: number; omittedTaskCount?: number; noLongTasks?: boolean; profilerOverheadMs?: number } | undefined;
  return {
    apiVersion: INTEGRATION_API_VERSION,
    analysisId: result.analysisId,
    profileType: "cpu" as const,
    title: result.title,
    summary: {
      totalMs: result.totalMs,
      callCountIsExact: result.callCountIsExact,
      profileFunctions: result.profileFunctions,
      // How many tasks the recording held in all. A client's header says "3
      // long tasks of 870", and nothing on a card can tell it the 870.
      taskCount: taskCards?.taskCount,
      omittedTaskCount: taskCards?.omittedTaskCount,
      noLongTasks: taskCards?.noLongTasks,
      profilerOverheadMs: taskCards?.profilerOverheadMs,
    },
    cards: ((taskCards?.cards ?? result.cards ?? result.hotspots ?? []) as unknown[]).map(summarizedCard),
  };
}

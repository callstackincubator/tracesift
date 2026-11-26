import { bearerToken, failCapture, updateCaptureFromExtension } from "@/lib/capture-store";
import type { CaptureStopReason } from "@/lib/capture-types";

export const runtime = "nodejs";

const states = new Set(["attaching", "recording", "flushing", "enriching", "failed", "interrupted"]);
const reasons = new Set<CaptureStopReason>(["manual", "buffer_limit", "target_closed", "detached", "shutdown", "error"]);

export async function POST(request: Request, context: RouteContext<"/api/captures/[id]/ingest/status">): Promise<Response> {
  const { id } = await context.params;
  let body: { state?: unknown; stopReason?: unknown; bufferUsage?: unknown; eventCount?: unknown; warning?: unknown; error?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected a status update." }, { status: 400 }); }
  try {
    if ((body.state === "failed" || body.state === "interrupted") && typeof body.error === "string") {
      return Response.json({ capture: await failCapture(id, bearerToken(request), {
        error: body.error,
        interrupted: body.state === "interrupted",
        reason: reasons.has(body.stopReason as CaptureStopReason) ? body.stopReason as CaptureStopReason : undefined,
      }) });
    }
    const capture = await updateCaptureFromExtension(id, bearerToken(request), {
      state: states.has(String(body.state)) ? body.state as "attaching" | "recording" | "flushing" | "enriching" : undefined,
      stopReason: reasons.has(body.stopReason as CaptureStopReason) ? body.stopReason as CaptureStopReason : undefined,
      bufferUsage: typeof body.bufferUsage === "number" ? body.bufferUsage : undefined,
      eventCount: typeof body.eventCount === "number" ? body.eventCount : undefined,
      warning: typeof body.warning === "string" ? body.warning : undefined,
      error: typeof body.error === "string" ? body.error : undefined,
    });
    return Response.json({ capture });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update capture status.";
    return Response.json({ error: message }, { status: message.includes("authorization") ? 401 : 400 });
  }
}

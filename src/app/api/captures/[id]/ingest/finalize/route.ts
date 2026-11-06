import { bearerToken, finalizeCapture } from "@/lib/capture-store";
import type { CaptureMainFrame, CaptureScriptMetadata, CaptureSourceMap, CaptureStopReason } from "@/lib/capture-types";

export const runtime = "nodejs";

const reasons = new Set<CaptureStopReason>(["manual", "buffer_limit", "target_closed", "detached", "shutdown", "error"]);

export async function POST(request: Request, context: RouteContext<"/api/captures/[id]/ingest/finalize">): Promise<Response> {
  const { id } = await context.params;
  let body: { dataLoss?: unknown; stopReason?: unknown; scripts?: unknown; sourceMaps?: unknown; warnings?: unknown; mainFrame?: unknown; traceMarker?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected capture finalization details." }, { status: 400 }); }
  try {
    const capture = await finalizeCapture(id, bearerToken(request), {
      dataLoss: body.dataLoss === true,
      stopReason: reasons.has(body.stopReason as CaptureStopReason) ? body.stopReason as CaptureStopReason : undefined,
      scripts: Array.isArray(body.scripts) ? body.scripts as CaptureScriptMetadata[] : [],
      sourceMaps: Array.isArray(body.sourceMaps) ? body.sourceMaps as CaptureSourceMap[] : [],
      warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
      mainFrame: body.mainFrame && typeof body.mainFrame === "object" ? body.mainFrame as CaptureMainFrame : undefined,
      traceMarker: typeof body.traceMarker === "string" ? body.traceMarker : undefined,
    });
    return Response.json({ capture });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not finalize the capture.";
    return Response.json({ error: message }, { status: message.includes("authorization") ? 401 : 400 });
  }
}

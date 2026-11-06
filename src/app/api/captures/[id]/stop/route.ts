import { requestCaptureStop } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function POST(_request: Request, context: RouteContext<"/api/captures/[id]/stop">): Promise<Response> {
  const { id } = await context.params;
  try {
    return Response.json({ capture: await requestCaptureStop(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stop the capture.";
    return Response.json({ error: message }, { status: message === "Capture not found." ? 404 : 400 });
  }
}

import { deleteCapture, getCapture } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/captures/[id]">): Promise<Response> {
  const { id } = await context.params;
  try {
    const capture = await getCapture(id);
    return capture
      ? Response.json({ capture }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Capture not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "Invalid capture id." }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext<"/api/captures/[id]">): Promise<Response> {
  const { id } = await context.params;
  try {
    return await deleteCapture(id)
      ? new Response(null, { status: 204 })
      : Response.json({ error: "Capture not found." }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not delete the capture." }, { status: 409 });
  }
}

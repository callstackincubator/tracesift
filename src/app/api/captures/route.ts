import { createCapture, listCaptures } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ captures: await listCaptures() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  let body: { title?: unknown; target?: { tabId?: unknown; title?: unknown; url?: unknown } };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected capture details." }, { status: 400 }); }
  const target = body.target;
  if (!target || typeof target.tabId !== "number" || typeof target.title !== "string" || typeof target.url !== "string") {
    return Response.json({ error: "Choose a Chrome tab to capture." }, { status: 400 });
  }
  try {
    const result = await createCapture({
      title: typeof body.title === "string" ? body.title : undefined,
      target: { tabId: target.tabId, title: target.title, url: target.url },
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create the capture." }, { status: 409 });
  }
}

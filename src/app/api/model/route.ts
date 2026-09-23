import { clearModelConfiguration, configureModel, getModelSettings } from "@callstack/tracesift/runtime";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  return Response.json(await getModelSettings(), {
    headers: {
      "Cache-Control": "no-store",
      ...(process.env.TRACE_SIFT_INSTANCE ? { "x-tracesift-instance": process.env.TRACE_SIFT_INSTANCE } : {}),
    },
  });
}

export async function PUT(request: Request): Promise<Response> {
  let body: { provider?: unknown; model?: unknown; apiKey?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected a model settings JSON body." }, { status: 400 }); }
  if (typeof body.provider !== "string" || typeof body.model !== "string" || (body.apiKey !== undefined && typeof body.apiKey !== "string")) {
    return Response.json({ error: "Provider, model, and API key must be strings." }, { status: 400 });
  }
  try {
    return Response.json(await configureModel({ provider: body.provider, model: body.model, apiKey: body.apiKey }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save model settings." }, { status: 400 });
  }
}

export async function DELETE(): Promise<Response> {
  try {
    return Response.json(await clearModelConfiguration());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not clear model settings." }, { status: 500 });
  }
}

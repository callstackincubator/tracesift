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
  let body: { provider?: unknown; model?: unknown; authMode?: unknown; apiKey?: unknown };
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON.' }, { status: 415 });
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected a model settings JSON body." }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid model settings.' }, { status: 400 });
  if (typeof body.provider !== "string" || typeof body.model !== "string" || (body.authMode !== undefined && !['api_key', 'oauth'].includes(String(body.authMode))) || (body.apiKey !== undefined && typeof body.apiKey !== "string")) {
    return Response.json({ error: "Invalid model settings." }, { status: 400 });
  }
  try {
    return Response.json(await configureModel({ provider: body.provider, model: body.model, authMode: body.authMode as 'api_key' | 'oauth' | undefined, apiKey: body.apiKey }));
  } catch {
    return Response.json({ error: "Could not save model settings. Check your provider, model, and authentication." }, { status: 400 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON.' }, { status: 415 });
  try { const body = await request.json(); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error(); }
  catch { return Response.json({ error: 'Expected an empty JSON object.' }, { status: 400 }); }
  try {
    return Response.json(await clearModelConfiguration());
  } catch {
    return Response.json({ error: "Could not clear model settings." }, { status: 500 });
  }
}

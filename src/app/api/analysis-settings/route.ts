import { getAnalysisSettings, saveAnalysisSettings } from "@/lib/analysis";

export const runtime = "nodejs";
export async function GET(): Promise<Response> { return Response.json(await getAnalysisSettings()); }
export async function PUT(request: Request): Promise<Response> {
  let body: { autoSave?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Expected a settings JSON body." }, { status: 400 }); }
  if (typeof body.autoSave !== "boolean") return Response.json({ error: "autoSave must be a boolean." }, { status: 400 });
  return Response.json(await saveAnalysisSettings({ autoSave: body.autoSave }));
}

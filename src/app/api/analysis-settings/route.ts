import { getAnalysisSettings, saveAnalysisSettings } from "@/lib/analysis";

export const runtime = "nodejs";
export async function GET(): Promise<Response> { return Response.json(await getAnalysisSettings()); }
export async function PUT(request: Request): Promise<Response> {
  let body: { autoSave?: unknown; aiAssisted?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Expected a settings JSON body." }, { status: 400 }); }
  if (body.autoSave !== undefined && typeof body.autoSave !== "boolean") return Response.json({ error: "autoSave must be a boolean." }, { status: 400 });
  if (body.aiAssisted !== undefined && typeof body.aiAssisted !== "boolean") return Response.json({ error: "aiAssisted must be a boolean." }, { status: 400 });
  // Each toggle is saved on its own, so writing one cannot silently reset the
  // other back to its default.
  if (body.autoSave === undefined && body.aiAssisted === undefined) {
    return Response.json({ error: "Expected autoSave, aiAssisted, or both." }, { status: 400 });
  }
  return Response.json(await saveAnalysisSettings({
    ...(typeof body.autoSave === "boolean" ? { autoSave: body.autoSave } : {}),
    ...(typeof body.aiAssisted === "boolean" ? { aiAssisted: body.aiAssisted } : {}),
  }));
}

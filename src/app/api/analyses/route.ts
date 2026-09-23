import { getRecord, getSavedAnalysis, listSavedAnalyses, saveAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ analyses: await listSavedAnalyses() });
}

export async function POST(request: Request): Promise<Response> {
  let body: { analysisId?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Expected an analysisId." }, { status: 400 }); }
  const id = typeof body.analysisId === "string" ? body.analysisId : "";
  const record = getRecord(id) ?? await getSavedAnalysis(id);
  if (!record) return Response.json({ error: "Analysis not found." }, { status: 404 });
  const saved = await saveAnalysis(record);
  return Response.json({ analysis: saved });
}

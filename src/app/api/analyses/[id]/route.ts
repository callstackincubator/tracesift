import { deleteSavedAnalysis, getSavedAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/analyses/[id]">): Promise<Response> {
  const { id } = await context.params;
  const analysis = await getSavedAnalysis(id);
  return analysis ? Response.json({ analysis }) : Response.json({ error: "Analysis not found." }, { status: 404 });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/analyses/[id]">): Promise<Response> {
  const { id } = await context.params;
  return await deleteSavedAnalysis(id) ? new Response(null, { status: 204 }) : Response.json({ error: "Invalid analysis id." }, { status: 400 });
}

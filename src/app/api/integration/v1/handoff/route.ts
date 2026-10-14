import { POST as cpuHandoff } from "@/app/api/hotspot-prompt/route";
import { POST as reactHandoff } from "@/app/api/react-issue-prompt/route";
import { findAnalysis } from "@/lib/analysis";
import { analysisNotFoundResponse, authorizeIntegrationRequest, integrationJson, INTEGRATION_API_VERSION } from "@/lib/integration-api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const denied = authorizeIntegrationRequest(request);
  if (denied) return denied;
  let body: { analysisId?: unknown; cardId?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return integrationJson({ error: "Expected a JSON body with analysisId and cardId." }, 400); }
  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const cardId = typeof body?.cardId === "string" ? body.cardId : "";
  if (!analysisId || !cardId) return integrationJson({ error: "analysisId and cardId are required." }, 400);

  const record = await findAnalysis(analysisId);
  if (!record) return analysisNotFoundResponse();
  const isReactCard = Boolean(record.reactCards?.cards.some((entry) => entry.id === cardId)
    || record.reactIssues.some((entry) => entry.id === cardId));
  const isCpuCard = Boolean(record.taskCards?.cards.some((entry) => entry.id === cardId)
    || record.cards?.some((entry) => entry.id === cardId)
    || record.hotspots.some((entry) => entry.id === cardId));
  if (!isReactCard && !isCpuCard) return integrationJson({ error: "Unknown card id for this analysis." }, 404);

  const target = isReactCard ? reactHandoff : cpuHandoff;
  const targetBody = isReactCard
    ? { analysisId, issueId: cardId }
    : { analysisId, hotspotId: cardId };
  const response = await target(new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targetBody),
    signal: request.signal,
  }));
  const result = await response.json() as { prompt?: unknown; error?: unknown };
  if (!response.ok) return integrationJson(result, response.status);
  return integrationJson({ apiVersion: INTEGRATION_API_VERSION, handoff: result.prompt });
}

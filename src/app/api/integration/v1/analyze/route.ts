import { POST as analyzeCpu } from "@/app/api/analyze/route";
import { POST as analyzeReact } from "@/app/api/analyze/react/route";
import {
  authorizeIntegrationRequest,
  detectIntegrationProfileType,
  integrationEngineConflict,
  normalizedIntegrationAnalysis,
  type IntegrationProfileType,
} from "@/lib/integration-api";
import { maxUploadBytes, uploadTooLargeMessage } from "@/lib/analysis";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const denied = authorizeIntegrationRequest(request);
  if (denied) return denied;

  let form: FormData;
  try { form = await request.formData(); }
  catch { return json({ error: "Expected a multipart form containing the profile file." }, 400); }
  const profile = form.get("profile");
  if (!(profile instanceof File) || profile.size === 0) return json({ error: "A profile file is required." }, 400);
  if (profile.size > maxUploadBytes()) return json({ error: uploadTooLargeMessage() }, 413);

  const requested = form.get("profileType");
  if (requested !== null && requested !== "auto" && requested !== "cpu" && requested !== "react") {
    return json({ error: "profileType must be auto, cpu, or react." }, 400);
  }
  let profileType: IntegrationProfileType;
  if (requested === "cpu" || requested === "react") profileType = requested;
  else {
    try { profileType = detectIntegrationProfileType(JSON.parse(await profile.text())); }
    catch (error) {
      const detail = error instanceof SyntaxError
        ? "The uploaded file could not be parsed as JSON."
        : error instanceof Error ? error.message : "Could not detect the profile type.";
      return json({ error: detail }, 400);
    }
  }

  const engineConflict = integrationEngineConflict(profileType);
  if (engineConflict) return json({ error: engineConflict }, 409);

  const analyzerForm = new FormData();
  analyzerForm.set("profile", profile, profile.name);
  const response = await (profileType === "cpu" ? analyzeCpu : analyzeReact)(new Request(request.url, {
    method: "POST",
    body: analyzerForm,
    signal: request.signal,
  }));
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) return json(result, response.status);
  return json(normalizedIntegrationAnalysis(result));
}

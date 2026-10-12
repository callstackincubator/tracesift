import { authorizeIntegrationRequest, INTEGRATION_API_VERSION } from "../../../../../lib/integration-api.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const denied = authorizeIntegrationRequest(request);
  if (denied) return denied;
  return Response.json({
    apiVersion: INTEGRATION_API_VERSION,
    version: process.env.TRACE_SIFT_VERSION ?? null,
    instance: process.env.TRACE_SIFT_INSTANCE ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}

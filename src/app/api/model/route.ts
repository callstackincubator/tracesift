import { getModelStatus } from "@callstack/perf-ai/runtime";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  return Response.json(await getModelStatus(), {
    headers: {
      "Cache-Control": "no-store",
      ...(process.env.PERF_AI_INSTANCE ? { "x-perf-ai-instance": process.env.PERF_AI_INSTANCE } : {}),
    },
  });
}

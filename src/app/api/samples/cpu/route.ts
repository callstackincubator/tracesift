import { CPU_SAMPLE_ANALYSIS } from "@/lib/sample-analyses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ analysis: CPU_SAMPLE_ANALYSIS });
}

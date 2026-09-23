import { REACT_SAMPLE_ANALYSIS, REACT_SAMPLE_SUMMARY } from "@/lib/sample-analyses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ analysis: REACT_SAMPLE_ANALYSIS, summary: REACT_SAMPLE_SUMMARY });
}

import { REACT_SAMPLE_ANALYSIS, REACT_SAMPLE_SUMMARY } from "@/lib/sample-analyses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  // Without the commit timeline, which is 75 KB the browser has no use for: the
  // report renders from the cards, and the drill-down fetches the timeline from
  // `/api/react-commit` when it is opened. An analyzed upload is served the same
  // way, so the sample and the real thing reach the page in the same shape.
  const { reactExplore, ...analysis } = REACT_SAMPLE_ANALYSIS;
  void reactExplore;
  return Response.json(
    { analysis, summary: REACT_SAMPLE_SUMMARY },
    { headers: { "Cache-Control": "no-store" } },
  );
}

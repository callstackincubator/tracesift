import { appendCaptureRawChunk, bearerToken, MAX_RAW_CHUNK_BYTES } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/captures/[id]/ingest/raw">): Promise<Response> {
  const { id } = await context.params;
  try {
    const sequence = Number(new URL(request.url).searchParams.get("sequence"));
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Expected a non-negative trace chunk sequence.");
    if (declaredLength > MAX_RAW_CHUNK_BYTES) throw new Error("Raw trace chunk exceeds the 1 MB limit.");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_RAW_CHUNK_BYTES) throw new Error("Raw trace chunk exceeds the 1 MB limit.");
    const capture = await appendCaptureRawChunk(id, bearerToken(request), sequence, bytes);
    return Response.json({ nextSequence: capture.chunkCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not append the raw trace chunk.";
    return Response.json({ error: message }, { status: message.includes("authorization") ? 401 : 409 });
  }
}

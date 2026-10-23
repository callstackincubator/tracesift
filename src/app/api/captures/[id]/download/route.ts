import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { captureExport } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/captures/[id]/download">): Promise<Response> {
  const { id } = await context.params;
  try {
    const exported = await captureExport(id);
    if (!exported) return Response.json({ error: "This capture has no export yet." }, { status: 404 });
    const body = Readable.toWeb(createReadStream(exported.path)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(exported.sizeBytes),
        "Content-Disposition": `attachment; filename="${exported.fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ error: "Invalid capture id." }, { status: 400 });
  }
}

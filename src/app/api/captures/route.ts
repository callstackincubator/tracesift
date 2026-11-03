import { createCapture, listCaptures } from "@/lib/capture-store";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ captures: await listCaptures() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  let body: { title?: unknown; target?: {
    tabId?: unknown; title?: unknown; url?: unknown;
    platform?: unknown; targetId?: unknown; appId?: unknown; deviceName?: unknown;
  };
  };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected capture details." }, { status: 400 }); }
  const target = body.target;
  if (
    !target || typeof target.title !== "string" || typeof target.url !== "string"
    || (target.platform !== "react-native" && typeof target.tabId !== "number")
  ) {
    return Response.json({ error: "Choose a Chrome tab or a React Native app to capture." }, { status: 400 });
  }
  try {
    const result = await createCapture({
      title: typeof body.title === "string" ? body.title : undefined,
      target: {
        ...(typeof target.tabId === "number" ? { tabId: target.tabId } : {}),
        title: target.title,
        url: target.url,
        ...(target.platform === "chrome" || target.platform === "react-native" ? { platform: target.platform } : {}),
        ...(typeof target.targetId === "string" ? { targetId: target.targetId } : {}),
        ...(typeof target.appId === "string" ? { appId: target.appId } : {}),
        ...(typeof target.deviceName === "string" ? { deviceName: target.deviceName } : {}),
      },
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create the capture." }, { status: 409 });
  }
}

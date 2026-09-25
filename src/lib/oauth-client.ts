export interface OAuthAttempt {
  attemptId: string;
  provider: string;
  status: "pending" | "complete" | "failed" | "cancelled" | "timed_out";
  event?: {
    type: "auth_url" | "device_code" | "progress";
    url?: string;
    verificationUri?: string;
    userCode?: string;
    message?: string;
  };
  prompt?: { type: "manual_code"; message: string };
  error?: string;
}

export async function pollOAuthAttempt<TSettings>(
  attemptId: string,
  request: typeof fetch = fetch,
): Promise<{ attempt: OAuthAttempt; settings?: TSettings }> {
  const attemptResponse = await request(`/api/model/oauth?attemptId=${encodeURIComponent(attemptId)}`, { cache: "no-store" });
  if (!attemptResponse.ok) throw new Error("Could not check sign-in status.");

  const attempt = await attemptResponse.json() as OAuthAttempt;
  if (attempt.status !== "complete") return { attempt };

  const settingsResponse = await request("/api/model", { cache: "no-store" });
  if (!settingsResponse.ok) throw new Error("Could not refresh model settings.");
  return { attempt, settings: await settingsResponse.json() as TSettings };
}

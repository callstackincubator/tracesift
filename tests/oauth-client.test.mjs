import { test } from "node:test";
import assert from "node:assert/strict";
import { pollOAuthAttempt } from "../src/lib/oauth-client.ts";

test("completed OAuth polling returns refreshed model settings with the attempt", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith("/api/model/oauth")) {
      return Response.json({ attemptId: "attempt-1", provider: "anthropic", status: "complete" });
    }
    return Response.json({
      configured: false,
      providers: [{ id: "anthropic", authMethods: [{ type: "oauth", configured: true }] }],
    });
  };

  const result = await pollOAuthAttempt("attempt-1", request);

  assert.equal(result.attempt.status, "complete");
  assert.equal(result.settings.providers[0].authMethods[0].configured, true);
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/model/oauth?attemptId=attempt-1",
    "/api/model",
  ]);
  assert(requests.every(({ options }) => options.cache === "no-store"));
});

test("pending OAuth polling does not request model settings", async () => {
  let calls = 0;
  const result = await pollOAuthAttempt("attempt/2", async (url) => {
    calls += 1;
    assert.equal(url, "/api/model/oauth?attemptId=attempt%2F2");
    return Response.json({ attemptId: "attempt/2", provider: "openai-codex", status: "pending" });
  });

  assert.equal(result.attempt.status, "pending");
  assert.equal(result.settings, undefined);
  assert.equal(calls, 1);
});

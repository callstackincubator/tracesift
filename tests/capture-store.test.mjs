import assert from "node:assert/strict";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const unzip = promisify(gunzip);
const home = await mkdtemp(path.join(tmpdir(), "tracesift-captures-"));
process.env.TRACE_SIFT_HOME = home;
const store = await import("../src/lib/capture-store.ts");
const { coerceCdpProfile } = await import("../src/lib/js-profile.ts");

const target = { tabId: 42, title: "Profile target", url: "https://example.test/workflow" };

test("raw Chrome stream chunks are authorized, ordered, durable, and exported as an enhanced trace", async () => {
  const { capture, uploadToken } = await store.createCapture({ target });
  assert.equal(capture.state, "pending");
  assert.equal(capture.target.url, target.url);
  assert.equal("uploadTokenHash" in capture, false);

  await assert.rejects(
    store.appendCaptureRawChunk(capture.id, "wrong-token", 0, new Uint8Array()),
    /authorization failed/,
  );

  await store.updateCaptureFromExtension(capture.id, uploadToken, { state: "recording", bufferUsage: 0.25 });
  const events = [
    {
      name: "__tracesift_main_capture", cat: "blink.user_timing", ph: "R",
      ts: 900, pid: 1, tid: 2, args: {},
    },
    {
      name: "Profile", cat: "disabled-by-default-v8.cpu_profiler", id: "0x1", ph: "P",
      ts: 1000, pid: 1, tid: 2, args: { data: { startTime: 1000 } },
    },
    {
      name: "ProfileChunk", cat: "disabled-by-default-v8.cpu_profiler", id: "0x1", ph: "P",
      ts: 1000, pid: 1, tid: 3, args: { data: {
        timeDeltas: [100, 100],
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } },
            { id: 2, parent: 1, callFrame: { functionName: "runFlow", scriptId: "7", url: "https://example.test/app.js", lineNumber: 4, columnNumber: 2 } },
          ],
          samples: [2, 2],
        },
      } },
    },
  ];
  const rawTrace = Buffer.from(JSON.stringify({ traceEvents: events, metadata: { chrome: "preserved as events, not copied" } }), "utf8");
  const split = rawTrace.indexOf(Buffer.from('"ProfileChunk"')) + 5;
  await store.appendCaptureRawChunk(capture.id, uploadToken, 0, rawTrace.subarray(0, split));
  await assert.rejects(store.appendCaptureRawChunk(capture.id, uploadToken, 0, new Uint8Array()), /Expected trace chunk 1/);
  await store.appendCaptureRawChunk(capture.id, uploadToken, 1, rawTrace.subarray(split));

  const completed = await store.finalizeCapture(capture.id, uploadToken, {
    stopReason: "manual",
    scripts: [{ scriptId: "7", url: "https://example.test/app.js", sourceMapURL: "https://example.test/app.js.map", frameId: "frame-1" }],
    sourceMaps: [{ url: "https://example.test/app.js", sourceMapUrl: "https://example.test/app.js.map", sourceMap: { version: 3, sources: ["src/app.ts"], names: ["runFlow"], mappings: "AAAA" } }],
    mainFrame: { id: "frame-1", url: target.url, name: "" },
    traceMarker: "__tracesift_main_capture",
  });
  assert.equal(completed.state, "captured");
  assert.equal(completed.eventCount, 4);
  assert.equal(completed.chunkCount, 2);
  assert.equal(completed.sourceMapsSeen, 1);
  assert.ok(completed.export?.fileName.endsWith(".json.gz"));

  const exported = await store.captureExport(capture.id);
  const decoded = JSON.parse((await unzip(await readFile(exported.path))).toString("utf8"));
  assert.equal(decoded.metadata.traceSift.captureId, capture.id);
  assert.equal(Object.keys(decoded.metadata)[0], "enhancedTraceVersion");
  assert.equal(decoded.metadata.enhancedTraceVersion, 1);
  assert.deepEqual(Object.keys(decoded.metadata.sourceMaps[0]), ["url", "sourceMapUrl", "sourceMap"]);
  assert.equal(decoded.metadata.sourceMaps[0].sourceMap.names[0], "runFlow");
  assert.equal(decoded.metadata.traceSift.scripts[0].frameId, "frame-1");
  assert.equal(decoded.traceEvents.length, 4);
  assert.equal(decoded.traceEvents[0].name, "TracingStartedInBrowser");
  assert.equal(decoded.traceEvents[0].args.data.frames[0].processId, 1);
  assert.equal(decoded.traceEvents[0].args.data.frames[0].url, target.url);
  assert.equal(coerceCdpProfile(decoded).nodes.find((node) => node.id === 2)?.callFrame.functionName, "runFlow");

  assert.equal((await store.listCaptures())[0].id, capture.id);
  assert.equal(await store.deleteCapture(capture.id), true);
  assert.equal(await store.getCapture(capture.id), undefined);
});

test("only one active capture can exist", async () => {
  const first = await store.createCapture({ target });
  await assert.rejects(store.createCapture({ target: { ...target, tabId: 43 } }), /already active/);
  await store.failCapture(first.capture.id, first.uploadToken, { error: "test cleanup", interrupted: true });
  const second = await store.createCapture({ target: { ...target, tabId: 43 } });
  await store.failCapture(second.capture.id, second.uploadToken, { error: "test cleanup", interrupted: true });
});

test.after(async () => { await rm(home, { recursive: true, force: true }); });

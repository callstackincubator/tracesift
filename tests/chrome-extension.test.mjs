import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../packages/chrome-extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../packages/chrome-extension/manifest.json", import.meta.url), "utf8"));

test("capture extension requires a toolbar gesture on the exact capture page", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "125");
  assert.ok(manifest.permissions.includes("debugger"));
  assert.match(background, /chrome\.action\.onClicked\.addListener/);
  assert.match(background, /url\.pathname !== "\/capture"/);
  assert.match(background, /sender\.tab\?\.id !== pairing\.bridgeTabId/);
  assert.doesNotMatch(background, /message\.type === "PAIR"/);
  assert.doesNotMatch(background, /api\/captures\/pairing/);
});

test("capture extension pulls a bounded CDP stream instead of queueing event batches", () => {
  assert.match(background, /transferMode: "ReturnAsStream"/);
  assert.match(background, /"IO\.read"/);
  assert.match(background, /MAX_UPLOAD_BYTES = 192 \* 1024/);
  assert.doesNotMatch(background, /method === "Tracing\.dataCollected"/);
});

test("capture extension enables renderer metadata before tracing", () => {
  const pageEnable = background.indexOf('sendCommand(source, "Page.enable")');
  const tracingStart = background.indexOf('sendCommand(debuggee, "Tracing.start"');
  assert.ok(pageEnable >= 0);
  assert.ok(tracingStart > pageEnable);
  assert.match(background, /TracingStartedInPage/);
  assert.match(background, /"Page\.getFrameTree"/);
  assert.match(background, /performance\.mark/);
  assert.match(background, /traceMarker: capture\.traceMarker/);
});

test("source-map loading retains frame identity for frame targets", () => {
  assert.match(background, /params\.executionContextAuxData\?\.frameId/);
  assert.match(background, /\.\.\.\(script\.frameId \? \{ frameId: script\.frameId \} : \{\}\)/);
  assert.match(background, /script\.url \|\| undefined/);
});

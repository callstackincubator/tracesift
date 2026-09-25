import assert from "node:assert/strict";
import test from "node:test";
import { debugLog } from "../src/lib/debug-log.ts";

function captureLogs(run) {
  const original = console.log;
  const calls = [];
  console.log = (...parts) => calls.push(parts);
  try {
    run();
  } finally {
    console.log = original;
  }
  return calls;
}

test("debugLog is silent in production", () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.deepEqual(captureLogs(() => debugLog("api/analyze", "details")), []);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test("debugLog writes scoped diagnostics in development", () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const calls = captureLogs(() => debugLog("api/analyze", "details"));
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /^\[tracesift\] .* \[api\/analyze\]$/);
    assert.equal(calls[0][1], "details");
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

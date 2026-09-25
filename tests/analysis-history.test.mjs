import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = await mkdtemp(path.join(tmpdir(), "tracesift-history-"));
process.env.TRACE_SIFT_HOME = home;
const store = await import("../src/lib/analysis.ts");
const { CPU_SAMPLE_ANALYSIS, REACT_SAMPLE_ANALYSIS, REACT_SAMPLE_SUMMARY } = await import("../src/lib/sample-analyses.ts");

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: 0 };
const record = {
  id: "history-record-1", createdAt: 10, dir: "/raw-upload-never-persisted", totalMs: 40,
  hotspots: [], reactIssues: [], prompts: {}, usage, promptUsage: {}, profileType: "cpu", title: "profile.cpuprofile", saved: false,
};

test("local history defaults to auto-save and persists safe report data", async () => {
  assert.deepEqual(await store.getAnalysisSettings(), { autoSave: true });
  await store.saveAnalysis(record);
  const loaded = await store.getSavedAnalysis(record.id);
  assert.equal(loaded?.dir, "");
  assert.equal(loaded?.title, "profile.cpuprofile");
  assert.equal(loaded?.saved, true);
  assert.deepEqual(await store.listSavedAnalyses(), [{ id: record.id, createdAt: 10, profileType: "cpu", title: "profile.cpuprofile", totalTokens: 3, issueCount: 0 }]);
});

test("history settings and deletion are durable", async () => {
  assert.deepEqual(await store.saveAnalysisSettings({ autoSave: false }), { autoSave: false });
  assert.deepEqual(await store.getAnalysisSettings(), { autoSave: false });
  assert.equal(await store.deleteSavedAnalysis(record.id), true);
  assert.equal(await store.getSavedAnalysis(record.id), undefined);
});

test("bundled CPU sample has stable, sanitized UI metadata", () => {
  assert.equal(CPU_SAMPLE_ANALYSIS.id, "sample-cpu-hermes-date-formatting");
  assert.equal(CPU_SAMPLE_ANALYSIS.profileType, "cpu");
  assert.equal(CPU_SAMPLE_ANALYSIS.title, "Hermes CPU profile sample");
  assert.equal(CPU_SAMPLE_ANALYSIS.dir, "");
  assert.equal(CPU_SAMPLE_ANALYSIS.hotspots.length, 2);
  assert.equal(CPU_SAMPLE_ANALYSIS.usage.totalTokens, 6052);
});

test("bundled React sample has stable report metadata and its recorded issue", () => {
  assert.equal(REACT_SAMPLE_ANALYSIS.id, "sample-react-heavy-activity-heatmap");
  assert.equal(REACT_SAMPLE_ANALYSIS.profileType, "react");
  assert.equal(REACT_SAMPLE_ANALYSIS.reactIssues.length, 1);
  assert.equal(REACT_SAMPLE_ANALYSIS.reactIssues[0].components[0].component, "HeavyActivityHeatmap");
  assert.equal(REACT_SAMPLE_SUMMARY.frameBudgetMs, 16);
});

test.after(async () => { await rm(home, { recursive: true, force: true }); });

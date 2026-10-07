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
  hotspots: [], reactIssues: [], prompts: {}, usage, model: { provider: "OpenAI", model: "GPT test" }, promptUsage: {}, profileType: "cpu", title: "profile.cpuprofile", saved: false,
};

test("local history defaults to auto-save and persists safe report data", async () => {
  assert.deepEqual(await store.getAnalysisSettings(), { autoSave: true });
  await store.saveAnalysis(record);
  const loaded = await store.getSavedAnalysis(record.id);
  assert.equal(loaded?.dir, "");
  assert.equal(loaded?.title, "profile.cpuprofile");
  assert.equal(loaded?.saved, true);
  assert.deepEqual(loaded?.model, { provider: "OpenAI", model: "GPT test" });
  assert.deepEqual(await store.listSavedAnalyses(), [{ id: record.id, createdAt: 10, profileType: "cpu", title: "profile.cpuprofile", totalTokens: 3, issueCount: 0 }]);
});

test("history settings and deletion are durable", async () => {
  assert.deepEqual(await store.saveAnalysisSettings({ autoSave: false }), { autoSave: false });
  assert.deepEqual(await store.getAnalysisSettings(), { autoSave: false });
  assert.deepEqual(await store.saveAnalysisSettings({ autoSave: true }), { autoSave: true });
  assert.equal(await store.deleteSavedAnalysis(record.id), true);
  assert.equal(await store.getSavedAnalysis(record.id), undefined);
});

test("bundled CPU sample has stable, sanitized UI metadata", () => {
  assert.equal(CPU_SAMPLE_ANALYSIS.id, "sample-cpu-hermes-date-formatting");
  assert.equal(CPU_SAMPLE_ANALYSIS.profileType, "cpu");
  assert.equal(CPU_SAMPLE_ANALYSIS.title, "Hermes CPU profile sample");
  assert.equal(CPU_SAMPLE_ANALYSIS.dir, "");
  assert.equal(CPU_SAMPLE_ANALYSIS.taskCards.cards.length, 2);
  // Every frame in the sample resolved from the classification rules, so the
  // bundled report must not imply a model ran to produce it.
  assert.equal(CPU_SAMPLE_ANALYSIS.usage.totalTokens, 0);
  assert.equal(CPU_SAMPLE_ANALYSIS.taskCards.classesDegraded, false);
  for (const card of CPU_SAMPLE_ANALYSIS.taskCards.cards) {
    assert.equal(card.boundaries, "measured");
    assert.match(card.headline, / a \d+ ms task .* into the recording$/);
    assert.ok(card.durationMs > 0 && card.startMs >= 0);
    // Self time inside a task is a partition of it, so the culprits can never
    // claim more milliseconds than the task lasted.
    const self = card.culprits.reduce((sum, culprit) => sum + culprit.selfMs, 0);
    assert.ok(self <= card.durationMs, `${card.id} culprits claimed ${self} of ${card.durationMs} ms`);
  }
  // Tasks are disjoint, which is the property the node-based engine could not provide.
  const share = CPU_SAMPLE_ANALYSIS.taskCards.cards.reduce((sum, card) => sum + card.percentOfProfile, 0);
  assert.ok(share <= 100, `sample task shares summed to ${share}`);
});

test("bundled React sample has stable report metadata and its recorded issue", () => {
  assert.equal(REACT_SAMPLE_ANALYSIS.id, "sample-react-heavy-activity-heatmap");
  assert.equal(REACT_SAMPLE_ANALYSIS.profileType, "react");
  // The sample is now the measured engine's, so it carries cards and no issues.
  assert.equal(REACT_SAMPLE_ANALYSIS.reactIssues.length, 0);
  assert.equal(REACT_SAMPLE_ANALYSIS.usage.totalTokens, 0, "no model ran to produce it");
  const cards = REACT_SAMPLE_ANALYSIS.reactCards;
  assert.equal(cards.cards.length, 1);
  assert.equal(cards.budgetMs, 16);
  assert.equal(cards.commitsOverBudget, 1);
  assert.equal(cards.commitCount, 4);
  assert.equal(cards.causesRecorded, false, "this recording captured no render reasons");
  const [card] = cards.cards;
  assert.equal(card.id, "react-commit-1-1");
  assert.equal(card.durationMs, 169.7);
  assert.equal(card.culprits[0].component, "HeavyActivityHeatmap");
  assert.equal(card.culprits[0].selfMs, 124.8);
  assert.equal(REACT_SAMPLE_SUMMARY.frameBudgetMs, 16);
});

test.after(async () => { await rm(home, { recursive: true, force: true }); });

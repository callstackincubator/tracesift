import type { AnalysisRecord } from "./analysis";

/** Bundled reports are static, sanitized UI data — never an uploaded profile. */
export const CPU_SAMPLE_ANALYSIS: AnalysisRecord = {
  id: "sample-cpu-hermes-date-formatting",
  createdAt: 0,
  profileType: "cpu",
  title: "Hermes CPU profile sample",
  saved: false,
  dir: "",
  totalMs: 8128,
  hotspots: [
    {
      id: "b1", title: "toLocaleString date formatting dominates sorting inside getUserByUserName on _onFocus", combinedTimeMs: 2111.536, percentOfTotal: 25.98,
      stack: [], frameworkOnly: false, groupingCaller: "dispatchEvent", supportingFunctionIds: ["b1-f2", "b1-f1"],
      functions: [
        { id: "b1-f2", title: "[Native] datePrototypeToLocaleStringHelper", selfTimeMs: 2050.247, percentOfGroup: 97.1, stack: [] },
        { id: "b1-f1", title: "[Native] jsonParse", selfTimeMs: 21.662, percentOfGroup: 1.03, stack: [] },
      ],
      summary: ["Native datePrototypeToLocaleStringHelper costs 2050 ms of self time, reached through arrayPrototypeSort inside getUserByUserName from the _onFocus dispatch.", "getUserByUserName also spends 21.7 ms in native jsonParse on the same focus-triggered path."],
    },
    {
      id: "b3", title: "Intl date formatting in a map plus localeCompare sorting during the _onChange handler", combinedTimeMs: 610.13, percentOfTotal: 7.51,
      stack: [], frameworkOnly: false, groupingCaller: "dispatchEvent", supportingFunctionIds: ["b3-f2", "b3-f8", "b3-f4"],
      functions: [
        { id: "b3-f2", title: "[Native] intlDateTimeFormatFormat", selfTimeMs: 418.992, percentOfGroup: 68.67, stack: [] },
        { id: "b3-f8", title: "[Native] stringPrototypeLocaleCompare", selfTimeMs: 96.039, percentOfGroup: 15.74, stack: [] },
        { id: "b3-f4", title: "[GC Young Gen]", selfTimeMs: 55.248, percentOfGroup: 9.06, stack: [] },
      ],
      summary: ["Native intlDateTimeFormatFormat costs 419 ms of self time via formatDate inside arrayPrototypeMap, triggered from _onChange.", "stringPrototypeLocaleCompare adds 96 ms inside arrayPrototypeSort's comparator (_temp3) on the same _onChange path.", "55 ms of young-gen GC sits under the Intl.DateTimeFormat constructor called by formatDate, indicating allocation pressure from formatter construction."],
    },
  ],
  reactIssues: [], prompts: {}, usage: { input: 5341, output: 711, cacheRead: 0, cacheWrite: 0, totalTokens: 6052, costUsd: 0 }, promptUsage: {},
};

export const REACT_SAMPLE_ANALYSIS: AnalysisRecord = {
  id: "sample-react-heavy-activity-heatmap",
  createdAt: 0,
  profileType: "react",
  title: "React component profile sample",
  saved: false,
  dir: "",
  totalMs: 172.964,
  hotspots: [],
  reactIssues: [{
    id: "react-issue-1", summary: "HeavyActivityHeatmap mount stalls explore-details first paint by ~125 ms", severity: "high",
    evidence: "HeavyActivityHeatmap used 124.8 ms self time on its single mount, about 74% of the 169.7 ms commit that opened explore-details.\nThe screen's first paint is blocked for roughly that long on the UI thread.",
    commits: [{ rootID: 1, commitIndex: 1, timestampMs: 1737.9347079992294, durationMs: 169.74 }],
    componentId: "1:728", component: "HeavyActivityHeatmap", selfTimeMs: 124.823, percentOfCommit: 73.5,
  }],
  prompts: {}, usage: { input: 12016, output: 403, cacheRead: 8000, cacheWrite: 0, totalTokens: 20419, costUsd: 0 }, promptUsage: {},
};

export const REACT_SAMPLE_SUMMARY = {
  rootCount: 1, commitCount: 4, totalCommitRenderDurationMs: 172.964, peakCommitDurationMs: 169.74,
  commitsOverBudget: 1, omittedEvidenceCommitCount: 0, frameBudgetMs: 16,
};

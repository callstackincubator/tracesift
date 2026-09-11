# Offline React profile analysis

Perf-ai installs `agent-react-devtools@0.4.0` and extends its CLI with a committed `patch-package` patch. The server launches Node with the installed CLI path; no terminal window, connected app, daemon, or `react-devtools-core` is needed.

```sh
./node_modules/.bin/agent-react-devtools profile slow \
  --file react-profile.json --limit 10 --json
```

Offline flags:

| Flag | Behavior |
| --- | --- |
| `--analysis-evidence` | Include bounded commit and component evidence alongside the unchanged ranking |
| `--file` | React DevTools exported JSON, version 5 |
| `--json` | One JSON document on stdout; omit for readable text |
| `--limit` | 1–100, default 10 |
| `--root-id` | Restrict to one root |
| `--component-name` | Case-insensitive display-name substring |
| `--min-avg-duration` | Minimum average inclusive duration in milliseconds, default 0 |

Only components with positive average duration are included. Filters precede limiting. Exit code 2 means invalid input or unsupported profile encoding; 1 means an internal failure. Errors go to stderr. Existing live commands and offline `profile diff` keep their behavior.

## Measurements and compatibility

The new helper reuses the package's export loader and extends its aggregation approach, retaining separate `(rootID, fiberID)` identities rather than merging display names. It replays initial snapshots and commit operations before measuring each commit. Removed components retain their recorded statistics. Unknown metadata is explicit (`metadataMissing`, fallback name, nullable element type).

Output has `schemaVersion: 1`, `profileType: "react"`, `ranking: "avgActualDurationMs"`, applied `filters`, a `summary`, and `components`. Each component includes inclusive and self durations (total, average, maximum), render count, available self count, identity/name/key/type, and the peak commit's zero-based index and relative timestamp in milliseconds. Ties use maximum inclusive duration, root ID, then fiber ID. Root and host nodes are excluded.

Average inclusive duration divides by the number of commits where that instance rendered, including zero-duration entries. Missing self data is not zero: if any rendered commit lacks a self duration, aggregate self metrics are null and `selfRenderCount` records availability. Inclusive durations overlap across ancestors. `totalCommitRenderDurationMs` sums commit render-phase durations; it is neither elapsed recording time nor the sum of component timings. The summary separately reports candidates, matches, and matches omitted by the limit.

The decoder is pinned to the operation format in React's [v19.1.0 CommitTreeBuilder](https://github.com/facebook/react/blob/v19.1.0/packages/react-devtools-shared/src/devtools/views/Profiler/CommitTreeBuilder.js). Its MIT notice is included in the package patch. It supports add/remove/reorder, base-duration, error/warning, and subtree-mode operations. Empty per-commit operation lists are also accepted, as produced by the agent's export fallback. Unsupported or malformed encodings are rejected; export version 5 alone does **not** establish compatibility with every DevTools release.

The checked-in fixture is synthetic, targeting the shared wire format used by React Native DevTools. Its provenance and expected values are in `test-fixtures/react/README.md`. A device-produced React Native recording and visual comparison with its matching DevTools release remain necessary before claiming verified device compatibility.

## Analyzer API

```sh
curl -X POST http://localhost:3000/api/analyze/react \
  -F profile=@react-profile.json \
  -F limit=10 \
  -F componentName=Row \
  -F minAvgDurationMs=2
```

Optional multipart fields are `limit` (1–12, default 10), `rootId`, `componentName` (1–200 characters), `minAvgDurationMs`, and `frameBudgetMs` (finite positive milliseconds, default 16). Maximum upload size is 25 MB.

The response is `{ profileType: "react", analysisId, summary, issues, noIssue, reasoning, frameBudgetMs, usage }`. `analysisId` is set when `issues` is nonempty so the UI can generate a copy-paste debugging prompt; it is `null` for zero findings. The measured ranking is not returned. `issues` contains only selected findings, with `id`, `summary`, `severity`, `evidence`, required `componentId`/`component`, supporting `commits`, and `suggestedFix`. Commit references include server-resolved `rootID`, zero-based `commitIndex`, `timestampMs`, and `durationMs`. The UI displays commit numbers starting at one. Root-wide or unattributed commit observations belong in `reasoning`, not `issues`; an over-budget commit alone does not establish an actionable component finding. The server discards legacy issues without a component ID and recomputes `noIssue`.

Analysis uses all commits in the selected root scope, independently of ranking limits, name filters, and minimum-average filters. Summary fields include scoped commit count, total render time, peak commit duration, `commitsOverBudget`, and `omittedEvidenceCommitCount`.

### Evidence and issue selection

The evidence aggregation and significance policy are adapted from ai-harness's `trace-evidence.ts`, React analyzer prompt, and `discardSubBudgetAnalyzerIssues`, without a runtime dependency. Extraction retains perf-ai's tree replay, instance identities, and strict format validation. Names such as `NavigationContent` and `Context.Provider` are not blacklisted: inclusive wrapper timings alone are insufficient evidence of a problem.

The optional CLI evidence includes the 50 slowest commits across scoped roots, up to 10 rendered components per commit ranked by self time, and three 15-component rankings (average inclusive duration, render count, total self duration). Omitted counts are explicit. Summary metrics and a server-only duration list cover every scoped commit, before truncation. Timings remain unrounded. Missing self timings and render reasons remain unknown; recorded changed props/hooks identify fields, not historical values. Names/keys are capped at 200 characters, changed-field lists at 20 entries, and unusually verbose model input further truncates changed fields with `textTruncated: true`. It can also omit lower-self-time component rows and extra updater names, updating their omitted counts to keep the prompt bounded.

All commits at or below the configured budget return HTTP 200 with `issues: []`, `noIssue: true`, reasoning, and zero model usage. Above-budget recordings still allow zero findings. Reports must cite recorded, over-budget commits, and component-specific findings must reference a component present in each cited commit. The server resolves measurements and names rather than trusting model-supplied values. Frequent cheap renders, normal mounts, provider updates, and duplicate wrapper cascades do not establish actionable issues.

An empty raw ranking is successful and does not prevent analysis. A root scope with no recorded commits returns 422 for insufficient evidence. Zero findings describe the captured React render work, not a guarantee that other sources of delay are absent.

The server uses `execFile`, argument arrays, a 30-second extraction timeout, an 8 MB analysis-output limit (the plain ranking wrapper retains its 1 MB default), and request cancellation. Uploads are removed after success or failure. The analyzer has no built-in file or shell tools and uses the configured provider when analysis is needed. HTTP errors include 400 invalid input, 413 oversized upload, 422 no commits, 499 cancellation, 502 invalid CLI/model output, and 504 extraction timeout; provider errors retain their status.

The web UI shows selected issues and does not display the raw component ranking. Each issue includes the same Generate prompt control as the JavaScript profiler: `POST /api/react-issue-prompt` with `{ analysisId, issueId }` returns a copy-paste debugging prompt from the stored finding. Prompt records live in memory for up to one hour. The numeric commit budget defaults to 16 ms; for example, enter 8.33 ms for a higher refresh-rate target. There is no interaction-description input. Uploads are still removed after success or failure.

## Maintaining the patch

`npm ci` runs `patch-package --error-on-fail`. Keep install scripts enabled. `patch-package` is a runtime dependency so production installs can apply the patch. Next keeps the package external and explicitly traces its executable/helper files.

To update the local extension, edit `node_modules/agent-react-devtools/dist/profile-offline.js` or its CLI dispatch, then run:

```sh
npx patch-package agent-react-devtools
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:production
```

The patch targets published JavaScript, not unpublished TypeScript sources. Keep the package pinned until an intentional upgrade passes the fixture and production tests. When upstream provides equivalent file-input, instance identity, and JSON behavior, replace the patch with that version, adapt the boundary validator if needed, and rerun the same tests. Do not maintain a second extractor in perf-ai.

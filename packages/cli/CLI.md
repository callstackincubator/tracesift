# TraceSift CLI

Managed local AI-assisted CPU profile analysis. Requires macOS or Linux and Node.js ≥22.19.0. npm is needed to install the CLI; Git and build tools are not needed to run it.

```sh
npm install -g @callstack/tracesift
tracesift init
tracesift start
tracesift explore /path/to/analysis.json --task 0
tracesift explore /path/to/react-analysis.json --commit 1.2
tracesift record start --url https://example.com --duration 30s
tracesift record stop
tracesift record launch --url https://example.com
tracesift record close
```

`init` downloads the immutable, platform-specific web app archive selected by your CLI release, verifies its size and SHA-256 checksum, and installs it locally. It needs internet access to fetch the release artifact. Supported targets are macOS and Linux on arm64 or x64.

`start` serves the production app on `127.0.0.1:3000`, opens the browser after readiness, and keeps server logs in your terminal. Use `--port 3001` or `--no-open` as needed. Ctrl+C stops the server. Configure the provider, authentication method, and model through **Analysis settings** in the web interface. OpenAI and Callstack use API keys; ChatGPT Codex uses Plus/Pro subscription OAuth; Anthropic supports Claude OAuth or an API key. Codex offers browser or device-code sign-in. PI OAuth is experimental, and Claude extra usage may be billed separately. Model changes apply immediately, without restarting the server. No billable validation request is made; provider availability and account access are checked on the first analysis.

`explore` opens a CPU task or React commit from a compact TraceSift analysis file in the running local web app. Use `--task <index>` for a CPU task, optionally with `--focus <node-id>`, or `--commit <root-id>.<commit-index>` for a React commit. The analysis file carries the measured card and selection metadata; full Explore data remains in the local TraceSift service and does not pass through the invoking integration.

## Recording a trace

`record` captures a Chrome performance trace over the DevTools Protocol without the browser extension, which makes it the route to use from a harness such as Codex where no one is there to click. It launches its own Chrome against a throwaway profile, starts tracing before the page is navigated so page load is inside the recording, and detaches so the shell comes back immediately.

`record start` accepts `--url` to navigate once tracing is live, `--duration 30s` to stop on its own, `--headless` for an unattended run, `--chrome <path>` (or `CHROME_PATH`) to choose the binary, and `--user-data-dir <path>` to record against an existing profile — that profile must not already be open in Chrome. `record stop` ends the recording and waits for Chrome to flush; `record status` reports the last one. Only one recording runs at a time, and its state lives in `record.json` with diagnostics in `record.log`.

To profile something you had to sign in or click around to reach, open the browser first: `record launch [--url ...]` starts Chrome, leaves it running after the command returns and records its debugging endpoint in `browser.json`. Use the browser by hand, then run `record start`. With a launched browser open it attaches to that Chrome and does not navigate, so the trace covers what is already on screen; pass `--url` to navigate after tracing starts anyway. `--chrome`, `--user-data-dir` and `--headless` belong to `record launch` in that case. `record stop` leaves the launched browser open, so several profiles can come from one sign-in; `record close` quits it and deletes its profile when TraceSift created it, and refuses while a recording is running. With no launched browser, `record start` behaves as above: it starts its own Chrome, traces the page load and shuts that Chrome down afterwards. `record status` also reports a launched browser that is still open.

The trace goes to a running TraceSift when `service.json` points at one, arriving in its capture list exactly as an extension capture does, so the web app's own Stop button ends a CLI recording too. With no TraceSift running it writes the same `.json.gz` under `recordings/` in the TraceSift home, or wherever `--out` says. Force either with `--sink ingest` or `--sink local`.

Both routes produce the same enhanced-trace document: trace events, the scripts Chrome parsed, and any source maps that could be retained, so authored names survive an offline import. A trace recorded without a TraceSift running can be analyzed later through the Integration API's `analyze` endpoint or by uploading it in the web app.

## Local integrations

After the server is ready, `start` writes `service.json` in the TraceSift home. The mode-`0600` descriptor advertises the loopback base URL, TraceSift and integration API versions, owning process IDs, process instance, start time, and a random bearer token. It is removed when that server stops. Local integrations should validate the version and live process, authenticate every request with the bearer token, and treat an unreachable endpoint as a stale descriptor.

Integration API v1 provides authenticated health, profile analysis, per-card handoff, and React commit-timeline endpoints below `/api/integration/v1`. Analysis accepts a multipart `profile` plus an optional `profileType` of `auto`, `cpu`, or `react`; it returns the same ordered measured cards used by the web app. Handoff accepts an `analysisId` and `cardId` and returns the same deterministic investigation handoff as the matching web card. `GET /api/integration/v1/react-explore?analysisId=...` returns the full React drill-down for an analyzed React profile — `explore`, every commit against the clock with the tree each rendered, plus the `cards` behind them — the same data the web Explore view reads. It is not part of the analysis response because the timeline runs to several megabytes on a real recording; request it only when a reader opens the drill-down, and expect a 404 for an analysis that carries no timeline. Responses grow additively within a version: new fields may appear, existing ones keep their meaning. The API remains loopback-only and the raw upload is not included in the descriptor or response.

## Local files

The default home is `~/.tracesift`; set `TRACE_SIFT_HOME` to an absolute alternate directory to isolate an installation. `app/` contains the installed standalone web app, `config.json` stores the selected provider/model, authentication method, and API keys, `auth.json` stores TraceSift OAuth credentials, `process.json` is the active operation lock, `service.json` is the active local-integration descriptor, `record.json` and `record.log` belong to `record`, `browser.json` names a Chrome left open by `record launch`, and `recordings/` holds traces captured with no TraceSift running. Credentials are plaintext at rest with mode `0600` inside a `0700` home. Keys and tokens are submitted only to the local server, are never returned to the browser, and are not logged. TraceSift never reads `~/.pi/agent/auth.json`. Clearing all credentials removes TraceSift's selected model, API keys, and OAuth connections.

Replacing an installation requires its server to be stopped. Download and verification run in a staging directory; failures preserve the existing app and configuration. Repeating `init` for a complete matching release does nothing. Updating the globally installed CLI does not update the app until you run `init` again.

## Troubleshooting

- Missing/incomplete installation or version mismatch: run `tracesift init`.
- Missing model or rejected authentication: open **Analysis settings** and save a supported model with an API key or connected subscription.
- Occupied port: choose another with `--port`.
- Browser did not open: use the URL printed in the terminal.
- Active operation: stop the existing CLI/server first. Dead process locks recover automatically; if a lock is malformed, stop all TraceSift processes before manually removing `process.json`.
- Install failure: fix the prerequisite, download, or verification error printed above and rerun `init`.

## Releases

The published CLI contains `release.json` with its app version, immutable source revision, GitHub release tag, and the URL, SHA-256, and size of each supported platform archive. The release workflow builds and tests four native archives (`darwin`/`linux` × `arm64`/`x64`), uploads them to a draft GitHub Release, publishes the CLI with npm OIDC trusted publishing, then makes the release public. Changesets opens the version PR after a committed Changeset reaches `main`. To test the complete packaged flow locally without publishing or pushing a commit, run `npm run test:release:local` from the repository root. Add `-- --keep-open` to inspect the installed app in a browser and run a manual analysis. See [Contributing](../../CONTRIBUTING.md) for release setup, checks, and retry instructions.

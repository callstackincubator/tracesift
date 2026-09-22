# perf-ai CLI

Managed local AI-assisted CPU profile analysis. Requires macOS or Linux, Node.js ≥22.19.0, npm, and Git.

```sh
npm install -g @callstack/perf-ai
perf-ai init
perf-ai start
```

`init` clones the immutable source commit embedded in your CLI release, runs `npm ci --include=dev`, and builds the web app. It needs internet access and offers model setup afterward. Use `--skip-model` for noninteractive installation, then run `perf-ai model` in a terminal.

`model` offers OpenAI, Anthropic, and Callstack (Apex), searches their installed SDK model catalog offline, and accepts a hidden API key. A saved provider key can be reused or replaced. Ctrl+C cancels without changing configuration. No billable validation request is made; provider availability and account access are checked on the first analysis.

`start` serves the production app on `127.0.0.1:3000`, opens the browser after readiness, and keeps server logs in your terminal. Use `--port 3001` or `--no-open` as needed. Ctrl+C stops the server. After `perf-ai model`, restart to apply the new selection. Restarting clears existing in-memory analyses.

## Local files

The default home is `~/.perf-ai`; set `PERF_AI_HOME` to an absolute alternate directory to isolate an installation. `app/` contains the managed checkout and build, `config.json` stores the selected provider/model and API keys, and `process.json` is the active operation lock. Configuration is plaintext at rest with mode `0600` inside a `0700` home. Keys are never sent by the browser and are not logged by the CLI. Unrelated PI credentials and custom providers are not loaded.

Replacing an installation requires its server to be stopped. Dependencies and build run in a staging directory; failures preserve the existing app and configuration. Repeating `init` for a complete matching release does nothing. Updating the globally installed CLI does not update the app until you run `init` again.

## Troubleshooting

- Missing/incomplete installation or version mismatch: run `perf-ai init`.
- Missing model or rejected key: run `perf-ai model`, select a supported model/key, then restart.
- Occupied port: choose another with `--port`.
- Browser did not open: use the URL printed in the terminal.
- Active operation: stop the existing CLI/server first. Dead process locks recover automatically; if a lock is malformed, stop all perf-ai processes before manually removing `process.json`.
- Install failure: fix the prerequisite/network/build error printed above and rerun `init`.

## Releases

From a clean, committed repository containing the CLI implementation, run `npm pack --workspace @callstack/perf-ai`. Its prepack step writes ignored `release.json` with the public repository URL and current immutable commit. Push that commit to the public repository before publishing; an unpushed commit cannot be installed by users. Keep the CLI and root SDK versions aligned and bump both the CLI version and root workspace dependency for each release. Validate the package in a fresh checkout/home on macOS and Linux and verify npm scope publishing access before publishing the reviewed tarball. Never bypass prepack for production artifacts.

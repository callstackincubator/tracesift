# TraceSift CLI

Managed local AI-assisted CPU profile analysis. Requires macOS or Linux and Node.js ≥22.19.0. npm is needed to install the CLI; Git and build tools are not needed to run it.

```sh
npm install -g @callstack/tracesift
tracesift init
tracesift start
```

`init` downloads the immutable, platform-specific web app archive selected by your CLI release, verifies its size and SHA-256 checksum, and installs it locally. It needs internet access to fetch the release artifact. Supported targets are macOS and Linux on arm64 or x64.

`start` serves the production app on `127.0.0.1:3000`, opens the browser after readiness, and keeps server logs in your terminal. Use `--port 3001` or `--no-open` as needed. Ctrl+C stops the server. Configure the provider, model, and API key through **Analysis settings** in the web interface. Model changes apply immediately, without restarting the server. No billable validation request is made; provider availability and account access are checked on the first analysis.

## Local files

The default home is `~/.tracesift`; set `TRACE_SIFT_HOME` to an absolute alternate directory to isolate an installation. `app/` contains the installed standalone web app, `config.json` stores the selected provider/model and API keys, and `process.json` is the active operation lock. Configuration is plaintext at rest with mode `0600` inside a `0700` home. Keys are submitted only to the local server, are never returned to the browser, and are not logged. Unrelated PI credentials and custom providers are not loaded.

Replacing an installation requires its server to be stopped. Download and verification run in a staging directory; failures preserve the existing app and configuration. Repeating `init` for a complete matching release does nothing. Updating the globally installed CLI does not update the app until you run `init` again.

## Troubleshooting

- Missing/incomplete installation or version mismatch: run `tracesift init`.
- Missing model or rejected key: open **Analysis settings** and save a supported model and API key.
- Occupied port: choose another with `--port`.
- Browser did not open: use the URL printed in the terminal.
- Active operation: stop the existing CLI/server first. Dead process locks recover automatically; if a lock is malformed, stop all TraceSift processes before manually removing `process.json`.
- Install failure: fix the prerequisite, download, or verification error printed above and rerun `init`.

## Releases

The published CLI contains `release.json` with its app version, immutable source revision, GitHub release tag, and the URL, SHA-256, and size of each supported platform archive. Release automation builds and tests the standalone archives before publishing the npm package and GitHub release. To test the complete packaged flow locally without publishing or pushing a commit, run `node scripts/test-local-release.mjs` from the repository root. Add `--keep-open` to inspect the installed app in a browser and run a manual analysis. See [Contributing](../../CONTRIBUTING.md) for the local checkpoint and release workflow.

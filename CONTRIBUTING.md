# Contributing to TraceSift

## Prerequisites

- macOS, Linux.
- Node.js 22.19.0 or newer, npm, and Git available on `PATH` for development and release packaging. Installed CLI users only need Node.js after installing the package.
- Internet access for the initial development dependency installation and CLI package installation.
- An OpenAI, Anthropic, or Callstack Apex API key for manual analysis. Automated tests and builds do not require a real key.

## Set up the current checkout

```sh
git clone https://github.com/callstackincubator/tracesift.git
cd tracesift
npm ci
```

If you already have a checkout, run `npm ci` from its root. The root install also links the CLI workspace; no global CLI installation is needed.

Use a separate home for development so testing does not change your normal TraceSift configuration:

```sh
export TRACE_SIFT_HOME="$HOME/.tracesift-local-test"
```

Set the same `TRACE_SIFT_HOME` in every terminal used for these steps; without it, the app uses `~/.tracesift`.

Start the development server:

```sh
npm run dev -- --hostname 127.0.0.1
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

Configure the provider, model, and API key through **Analysis settings** in the web interface. For Apex, enter your `sk-...` virtual key, not the API endpoint URL. Configuration and keys are saved in `$TRACE_SIFT_HOME/config.json`; keep that file private and out of Git.

## Manually test analysis and model selection

1. Open **Analysis settings**, select a provider and model, enter its API key, and save.
2. Upload `test-fixtures/sample.cpuprofile` and start analysis. This sends a real request to the selected provider and may incur usage charges.
3. Check that the analysis completes and displays results. Inspect the server terminal if a request fails.
4. Change the model or key in **Analysis settings**.
5. Confirm the new selection applies without restarting and run another analysis.

Model configuration is stored in the local TraceSift home and changes apply immediately.

## Run automated checks

Run these commands from the repository root:

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:production
```

`npm test` runs the app and CLI tests, including configuration, installation, and subprocess lifecycle checks. `test:production` requires the preceding production build; it starts temporary servers and verifies startup configuration behavior without calling a model provider.

To test the CLI process lifecycle on its own:

```sh
node --test packages/cli/test/install-process.test.js
```

To manually test the production build of your current checkout, stop the development server and run:

```sh
npm start -- --hostname 127.0.0.1
```

Open the same local URL and repeat the manual analysis steps. Rebuild after changing application code.

## Test managed CLI installation and startup

Run the local release harness from the repository root:

```sh
node scripts/test-local-release.mjs
```

It builds the standalone app for your current platform, packages it, serves its archive over a loopback HTTP connection, and packs a temporary CLI with matching local release metadata. The harness installs that package and runs the real `tracesift init` twice in a temporary home, checking that the second run reuses the installation. It then runs `tracesift start --no-open` and checks `/api/model`. No GitHub push or npm publication is involved. The temporary package, server, and home are removed when the test ends.

For the manual checkpoint, keep the installed app running:

```sh
node scripts/test-local-release.mjs --keep-open
```

Open the URL printed by the harness. Configure **Analysis settings**, upload `test-fixtures/sample.cpuprofile`, and complete an analysis. This sends a real provider request and may incur usage charges. Press Ctrl+C to stop and clean up the temporary installation. Run this checkpoint before exercising the GitHub and npm release workflow.

The packaging script also supports direct inspection after `npm run build`:

```sh
node scripts/package-standalone.mjs
```

It writes the current-platform archive and its checksum/size sidecar under `dist/`. For release requirements and storage details, see the [CLI documentation](packages/cli/README.md).

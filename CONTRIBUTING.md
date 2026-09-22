# Contributing to perf-ai

## Prerequisites

- macOS, Linux.
- Node.js 22.19.0 or newer, npm, and Git available on `PATH`.
- Internet access to clone the repository, install dependencies, and build the app.
- An OpenAI, Anthropic, or Callstack Apex API key for manual analysis. Automated tests and builds do not require a real key.

## Set up the current checkout

```sh
git clone https://github.com/callstackincubator/perf-ai.git
cd perf-ai
npm ci
```

If you already have a checkout, run `npm ci` from its root. The root install also links the CLI workspace; no global CLI installation is needed.

Use a separate home for development so testing does not change your normal CLI configuration:

```sh
export PERF_AI_HOME="$HOME/.perf-ai-local-test"
node packages/cli/src/cli.js model
```

Select a provider, search for a model (or press Enter to list all), choose its number, and enter the API key at the hidden prompt. For Apex, enter your `sk-...` virtual key, not the API endpoint URL. When replacing a saved key, answer `n` to “Reuse saved API key?”.

Configuration and keys are saved in `$PERF_AI_HOME/config.json`. Keep that file private and out of Git. Set the same `PERF_AI_HOME` in every terminal used for these steps; without it, the app uses `~/.perf-ai`.

Start the development server:

```sh
npm run dev -- --hostname 127.0.0.1
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Manually test analysis and model selection

1. Open **Analysis settings**, select a provider and model, enter its API key, and save.
2. Upload `test-fixtures/sample.cpuprofile` and start analysis. This sends a real request to the selected provider and may incur usage charges.
3. Check that the analysis completes and displays results. Inspect the server terminal if a request fails.
4. Change the model or key in **Analysis settings**.
5. Confirm the new selection applies without restarting and run another analysis.

Model configuration is stored in the local Perf AI home and changes apply immediately.

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

`init` installs the source revision embedded in release metadata, rather than copying your working directory. To test a new revision end to end, commit the changes and push that commit to the public repository first. Packaging requires a clean checkout, including no untracked files. Move any previously generated tarballs outside the repository if they appear in `git status --short`.

From that clean checkout, create the package and release metadata:

```sh
PERF_AI_PACK_DIR="$(mktemp -d)"
npm pack --workspace @callstack/perf-ai --pack-destination "$PERF_AI_PACK_DIR"
```

This creates a local tarball and the ignored `packages/cli/release.json`; it does not publish to npm. Keeping the tarball outside the repository avoids making the checkout dirty for the next pack.

Use another isolated home to exercise installation:

```sh
export PERF_AI_HOME="$HOME/.perf-ai-cli-test"
node packages/cli/src/cli.js init
node packages/cli/src/cli.js start
```

Check that `init` clones the pinned commit, installs dependencies, and builds the app. Check that `start` opens the browser and allows model selection from **Analysis settings**. Press Ctrl+C to stop it.

Additional checks:

- Run `init` again after stopping the server: a complete matching installation should be reused.
- Run `node packages/cli/src/cli.js start --port 3001 --no-open`: open the printed URL manually and verify analysis works.
- Replace the model or key in **Analysis settings** and verify the selection without restarting.
- If installation fails, resolve the error shown above the final CLI message and rerun `init`.

Current-checkout npm commands work without release metadata. Direct `init` and `start` require it. After changing the pinned application revision, commit, push, and pack again. For release requirements and storage details, see the [CLI documentation](packages/cli/README.md).

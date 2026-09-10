# perf-ai

Analyze JavaScript CPU profiles locally with OpenAI, Anthropic, or Callstack Apex.

## CLI

Once the package is published:

```sh
npm install -g @callstack/perf-ai
perf-ai init
perf-ai start
```

Setup clones and builds a pinned revision and offers model selection. Change your provider, model, or API key with `perf-ai model`, then restart the server. See [CLI documentation](packages/cli/README.md) for prerequisites, storage, troubleshooting, and releases.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, manual testing, automated checks, and testing the managed CLI installation.

```sh
npm ci
node packages/cli/src/cli.js model
npm run dev
```

Open http://localhost:3000. The development server reads the same private configuration as the CLI on startup. Use the npm scripts so the Node preload captures configuration before Next.js starts listening. Set `PERF_AI_HOME` to use a separate configuration. Production builds do not need credentials:

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:production
npm start
```

The web UI displays the active model and never collects API keys. Analysis results are held in memory and disappear when the server restarts. The CLI package lives in `packages/cli`; it exports shared configuration, catalog, and server-runtime modules and uses the same pinned agent SDK version as the app.

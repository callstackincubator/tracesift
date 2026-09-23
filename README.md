# TraceSift

Finding performance bottlenecks in a CPU or React profile takes expertise. Handing the full profile to an agent can help, but it fills the context window and burns through tokens.

**TraceSift** identifies bottlenecks in your profile and presents them in a clear, readable format, with the slowest first.

Each bottleneck includes a button to generate or copy a handoff prompt, so your agent can continue the investigation in the source code. You decide what gets fixed; the agent does the work.

Runs locally with OpenAI, Anthropic, or Callstack Apex. Your credentials stay with you.

## CLI

Once the package is published:

```sh
npm install -g @callstack/tracesift
tracesift init
tracesift start
```

Setup clones and builds a pinned revision. After starting TraceSift, choose your provider and model and enter its API key in **Analysis settings**. See [CLI documentation](packages/cli/README.md) for prerequisites, storage, troubleshooting, and releases.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, manual testing, automated checks, and testing the managed CLI installation.

The web UI displays the active model and never collects API keys. Completed analyses can be stored locally under `~/.tracesift/analyses` (or `TRACE_SIFT_HOME`); auto-save is enabled by default and can be changed in Analysis settings. Saved reports include findings and generated handoff prompts, but never retain the raw uploaded profile. The CLI package lives in `packages/cli`; it exports shared configuration, catalog, and server-runtime modules and uses the same pinned agent SDK version as the app.

## Made with ❤️ at Callstack

**TraceSift** is an open source project and will always remain free to use. If you think it's cool, please star it 🌟.

[Callstack](https://www.callstack.com/) is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

## License

MIT

[license]: https://github.com/callstackincubator/tracesift/blob/main/LICENSE

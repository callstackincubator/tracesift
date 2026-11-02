---
"@callstack/tracesift": minor
---

Record Chrome performance traces from the CLI, without the browser extension.

`tracesift record start` launches its own Chrome over the DevTools Protocol and begins tracing before the page is navigated, so page load is inside the recording; `record stop` flushes it and `record status` reports the result. The trace streams into a running TraceSift when one is reachable and is written as a `.json.gz` otherwise. `tracesift record launch` instead opens a Chrome that stays running after the command returns, so you can sign in or navigate by hand; `record start` then attaches to it without navigating, `record stop` leaves it open for further recordings, and `record close` quits it. This gives harnesses such as Codex a route to a capture that needs no extension and no one to click.

The gzip exporter the web app already used is now shared from `@callstack/tracesift/trace-export`, so both routes produce the same enhanced-trace document. A `TracingStartedInBrowser` event that names no frames no longer suppresses the rebuilt frame metadata.

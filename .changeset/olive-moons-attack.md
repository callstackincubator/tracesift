---
"@callstack/tracesift": minor
---

Analyze gzipped traces, so an exported recording can be opened again.

A trace exported from a recording — by the web app's own Export trace button or by `tracesift record` with no TraceSift running — is a `.json.gz`, and nothing could read it back: the upload pane accepted only `.json` and both analyze routes parsed the upload as text. Uploads and the Integration API's `analyze` endpoint now inflate a gzipped profile before parsing it, decided by the file's own first bytes rather than its name, and refuse one that would exceed the upload ceiling once uncompressed.

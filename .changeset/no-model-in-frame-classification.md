---
"@callstack/tracesift": patch
---

Classify frames by rules alone, so uploading a CPU profile never calls a model.

Frame classification — which recorded frame is the reader's own code, a
dependency, the framework or the engine — showed the names no rule could
resolve to a model, and ran automatically on every CPU upload as soon as a
provider was configured. It left no visible trace on any card, only a token
count in the results header attributed to an "analyzer", which read as if the
cards themselves had been written by one. They never were: every number on a
card is measured, and the model only ever labelled frames.

That call is gone. `classifyFrames`, the classifier prompt and the
`~/.tracesift/frame-classes.json` cache are removed, and the table is built
from `classifyByRule` alone. A model now runs only where a reader asks for one
by name — "Explain with AI" on a card — plus the two engine escape hatches,
`TRACESIFT_CPU_ENGINE=legacy` and `TRACESIFT_REACT_ENGINE=analyzer`.

The rules are unchanged, so profiles carrying real paths are unaffected, and on
the two local traces the cards come out identical to the model-assisted run —
same tasks, same order, same boundary frames. What is lost is the mangled
residue inside a single bundled artefact: a named frame in an
`index.bundle` that no vendor chunk sits beside stays `library` rather than
being promoted to the reader's own code. Filing it as a dependency is the safe
direction — a frame wrongly presented as your own feature boundary is worse
than one left unclaimed — and the table reports it as `degraded` with a count
in the server log.

`ruleClassTable` now takes the profile's frames rather than being built empty.
It needs them to answer whether this build emitted a vendor chunk, which is
what decides how a bundled frame reads; the previous caller passed nothing and
so answered "no" for every profile, quietly demoting code-split web builds that
the model path had classified correctly.

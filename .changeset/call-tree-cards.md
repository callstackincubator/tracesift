---
"@callstack/tracesift": patch
---

Rebuild CPU analysis on a merged call tree, and drop the model from that path entirely.

The engine this replaces kept no call tree and no inclusive time: it rolled each sample's leaf self time up to one chosen caller, so a card was a flat bag of leaves and "what did this function's subtree cost" had no answer. Garbage-collection samples were discarded, every subtree under the naming floor vanished, `(anonymous)` was a legal card title, and `Function call` was filtered nowhere. Twenty groups became twelve prompts became eight functions became three rows.

CPU profiles now build a call tree whose siblings merge on frame identity — which is also what collapses a Hermes duration trace's one-node-per-invocation shape — carrying both self and inclusive time, with `total = self + sum(children)` exact by construction. A deterministic descent walks past frames that only delegate and stops where a function does substantial work in its own body or forks into several significant callees, inheriting a caller's name when a frame has none of its own and emitting one card per branch when it fans out. A frame that names only the framework — `beginWork`, `commitLayoutEffectOnFiber` — can no longer head a card: those report that React ran, never what to fix, so the descent walks through them to the application code underneath. Garbage collection and deoptimisation are charged to the frame that triggered them rather than discarded or mistaken for delegation.

Each card now carries its subtree eight levels deep, every function that ran underneath it rolled up by identity with its callers, and the heaviest named work as highlights with both times — `getReportSections - 243ms total time, 80ms self time`. A new Explore view opens one card's subtree in its own tab as a flame graph, an expandable call tree, and a table of repeated work. The copy hand-off is rebuilt on the same measurements: inclusive and self time, where the time goes, which helpers ran repeatedly and from where, how the code is reached, and where it burns below.

No model runs on the CPU path any more, so analysis is immediate and costs nothing. Invocation counts are only claimed for duration traces that actually record them; sampled profiles report call sites and say so. `native array.js`-style built-in frames are no longer presented as source files a developer could open.

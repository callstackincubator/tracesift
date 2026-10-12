---
"@callstack/tracesift": patch
---

Use one definition of an idle sample across the parser.

Choosing which profile in a multi-thread trace to analyse counted a sample as
idle only when the sampled frame was itself named `(idle)`, where the task
splitter and the call tree both treat anything *inside* an `(idle)` subtree as
idle. A sample under an idle frame was therefore work to one module and absence
of work to the other two.

No recording this changes: V8 emits `(idle)` as a childless frame, and across
both local traces — 217,934 samples, 59,478 nodes — not one sample lands inside
an `(idle)` subtree, so the chosen profile is identical before and after. It is
the inconsistency that is worth removing, not its effect, and the suite now
pins the case the three paths used to answer differently.

Also counts each profile once rather than once per comparison. It was called
from inside a sort comparator, which is what made a rule that has to walk the
node tree too expensive to share.

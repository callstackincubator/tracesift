---
"@callstack/tracesift": patch
---

Report CPU hotspots as bottlenecks rather than bursts. A caller sampled repeatedly is now one card carrying its burst count and longest run, instead of one card per burst crowding every other finding out of the report. Agent evidence is keyed to the function it describes instead of paired by position, and each row names its own function. Cards drop when a single React internal outweighs all the application work in them, or when the total is negligible against the profile. Captions keep their full text, and the unattributed-time footnotes state the threshold actually applied.

Attribute sampled work to the outermost application caller rather than the outermost caller of any kind. Under React the outermost frame is always the scheduler, so a whole render phase arrived as one unreadable card: on a 13.6 s production profile, 3.16 s of work across 178 functions was filed under `processRootScheduleInMicrotask`. That work now resolves into the components that did it, and React's `beginWork` dispatch arms are recognised as internals so they can no longer stand in for a component. The report shows more hotspots to match the finer grouping.

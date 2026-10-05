---
"@callstack/tracesift": patch
---

Stop a backwards step in the profiler's clock from shifting every task's samples.

V8's sampler reads a clock that can step backwards, so a recording carries negative time deltas — a thirteen-second Chrome trace of a web app runs to several hundred of them. Reconstructing sample timestamps clamped each one to zero, which is not a small rounding difference: the error never comes back, so the reconstructed clock runs ahead of the real one by the sum of every negative delta seen so far, 69 ms on that trace. The timestamps still looked plausible, and nothing downstream could tell. What it changed was the binary search that cuts a task's sample window, which then landed around 64 ms early for every task in the recording: a task took the tail of the one before it, lost the same amount of its own, and every box on its timeline was drawn that far to the right of where it ran — enough to be visible when a reader lines the chart up against Chrome's Performance panel.

The deltas are now added as recorded, with a running maximum to keep the series non-decreasing for the search. An inversion costs the few samples inside it their ordering and nothing else, because the clock rejoins the real one as soon as the following deltas make the time back up, instead of carrying the error to the end of the recording.

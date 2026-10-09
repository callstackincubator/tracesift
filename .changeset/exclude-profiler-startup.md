---
"@callstack/tracesift": patch
---

stop carding the profiler's own start-up as if it were the app's work

Switching a CPU profiler on stops the world, and V8 bills the pause to
whichever task was running — 2.9 s of one 16.7 s Chrome trace, the third
longest block in it, holding 6 ms of real JS and reading as "no code of your
own ran in this block". That block is now recognised from the tracer's own
`CpuProfiler::StartProfiling` event and reported as a total instead of
spending a card on it. Keying on the event rather than on a `(program)`-heavy
call tree matters: on a second trace V8 parked the same pause on an ordinary
application frame, where a shape-based guess would have missed it.

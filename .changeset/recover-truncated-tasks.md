---
"@callstack/tracesift": patch
---

account for samples the tracer stopped bounding, instead of dropping them

A `RunTask` still on the stack when recording stops is written as a bare `B`
with no matching `E`, and was being discarded — on a 16.7 s Chrome trace that
left 5.2 s of application work in no task at all, so a 206 ms function was
reported as the 103 ms of it that happened to land inside a measured window.
Unterminated tasks are now closed at the last event on their thread, any
samples still left over are recovered as inferred tasks, and both say on the
card that their edges are reconstructed rather than measured.
